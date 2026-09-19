/**
 * 章节版本仓库的差量快照原语。
 *
 * 快照以「发布节点（releaseNo）」为边界：全量快照周期性落地，
 * 相邻发布之间只存基于块 ID 有序序列的 LCS 编辑脚本（差量）。
 * 回滚同样产生一个新的发布节点，事件日志保持 append-only。
 */

/**
 * 差量快照片节，基于有序内容块 ID 序列的 LCS 编辑脚本。
 * - retain：保留 N 个旧块（内容变更由 updates 携带）
 * - insert：在当前位置插入新块（携带完整块数据）
 * - remove：删除 N 个旧块
 */
export type DeltaOp =
  | { type: 'retain'; count: number }
  | { type: 'insert'; blocks: BlockSnapshot[] }
  | { type: 'remove'; count: number };

/** 章节发布快照中单个内容块的可恢复形态 */
export type BlockSnapshot = {
  /** 发布时的 ChapterBlock.id；回滚重建后该 id 会整体换新 */
  blockId: string;
  blockType: string;
  position: string;
  contentJson: unknown;
  clipId: string | null;
};

export type ChapterSnapshot = {
  title: string;
  intro: string;
  blocks: BlockSnapshot[];
};

export type StoredSnapshot =
  | { kind: 'full'; snapshot: ChapterSnapshot }
  | {
      kind: 'delta';
      baseReleaseNo: number;
      ops: DeltaOp[];
      /** retain 住但内容发生变化的块，键为 blockId */
      updates?: Record<string, BlockSnapshot>;
      /** 快镜头部字段（标题/导语）不变时省略，避免冗余存储 */
      title?: string;
      intro?: string;
    };

/** 每 N 个发布节点强制落一个全量快照，防止差量链无限增长 */
export const FULL_SNAPSHOT_EVERY = 3;

export { chapterPublishSchema, chapterRollbackSchema } from '@history/contracts';
export type {
  ChapterPublishInput,
  ChapterRollbackInput,
} from '@history/contracts';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function stableJsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!isObject(a) || !isObject(b)) return false;
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function isBlockSnapshotEqual(a: BlockSnapshot, b: BlockSnapshot): boolean {
  return (
    a.blockId === b.blockId &&
    a.blockType === b.blockType &&
    a.position === b.position &&
    a.clipId === b.clipId &&
    stableJsonEqual(a.contentJson, b.contentJson)
  );
}

/**
 * 计算两个有序块序列之间的编辑脚本（LCS 以 blockId 对齐）。
 * 内容变化的保留块通过 updates 携带新数据。
 */
export function diffBlocks(
  oldBlocks: { id: string; block: BlockSnapshot }[],
  nextBlocks: { id: string; block: BlockSnapshot }[],
): { ops: DeltaOp[]; updates: Map<string, BlockSnapshot> } {
  const m = oldBlocks.length;
  const n = nextBlocks.length;

  // dp[i][j] = oldBlocks[i:] 与 nextBlocks[j:] 的最长公共子序列长度
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] =
        oldBlocks[i].id === nextBlocks[j].id
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: DeltaOp[] = [];
  const updates = new Map<string, BlockSnapshot>();
  const push = (op: DeltaOp) => {
    const last = ops[ops.length - 1];
    if (
      last &&
      ((op.type === 'retain' && last.type === 'retain') ||
        (op.type === 'remove' && last.type === 'remove'))
    ) {
      last.count += op.count;
    } else {
      ops.push(op);
    }
  };

  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldBlocks[i].id === nextBlocks[j].id) {
      if (!isBlockSnapshotEqual(oldBlocks[i].block, nextBlocks[j].block)) {
        updates.set(nextBlocks[j].id, nextBlocks[j].block);
      }
      push({ type: 'retain', count: 1 });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push({ type: 'remove', count: 1 });
      i += 1;
    } else {
      push({ type: 'insert', blocks: [nextBlocks[j].block] });
      j += 1;
    }
  }
  if (i < m) push({ type: 'remove', count: m - i });
  if (j < n) {
    push({ type: 'insert', blocks: nextBlocks.slice(j).map((item) => item.block) });
  }

  return { ops, updates };
}

/** 将编辑脚本应用到旧序列，得到新序列；updates 中内容变更的块被就地替换。 */
export function patchBlocks(
  oldBlocks: { id: string; block: BlockSnapshot }[],
  ops: DeltaOp[],
  updates: Map<string, BlockSnapshot>,
): BlockSnapshot[] {
  const next: BlockSnapshot[] = [];
  let index = 0;
  for (const op of ops) {
    if (op.type === 'retain') {
      for (let k = 0; k < op.count; k += 1) {
        const current = oldBlocks[index];
        if (!current) {
          throw new Error(`差量脚本越界：retain 超出基准快照（${index}）`);
        }
        next.push(updates.get(current.id) ?? current.block);
        index += 1;
      }
    } else if (op.type === 'remove') {
      index += op.count;
      if (index > oldBlocks.length) {
        throw new Error('差量脚本越界：remove 超出基准快照');
      }
    } else {
      for (const block of op.blocks) next.push(block);
    }
  }
  if (index !== oldBlocks.length) {
    throw new Error('差量脚本不完整：基准快照仍有未处理的块');
  }
  return next;
}

/** 沿 baseReleaseNo 链逐级还原，返回指定发布节点的完整快照。 */
export async function resolveSnapshot(
  target: StoredSnapshot,
  loadPrevious: (releaseNo: number) => Promise<StoredSnapshot> | StoredSnapshot,
): Promise<ChapterSnapshot> {
  if (target.kind === 'full') return cloneSnapshot(target.snapshot);

  const base = await resolveSnapshot(
    await loadPrevious(target.baseReleaseNo),
    loadPrevious,
  );
  const oldBlocks = base.blocks.map((block) => ({ id: block.blockId, block }));
  const blocks = patchBlocks(
    oldBlocks,
    target.ops,
    new Map(Object.entries(target.updates ?? {})),
  );
  return {
    title: target.title ?? base.title,
    intro: target.intro ?? base.intro,
    blocks,
  };
}

/**
 * 从旧的发布快照生成新的差量/全量快照。
 * 首个发布、回滚后的首个发布（调用方决定 releaseNo）以及每 FULL_SNAPSHOT_EVERY
 * 个发布落全量，其余落差量。
 */
export function buildReleaseSnapshot(
  releaseNo: number,
  previous: { releaseNo: number; snapshot: ChapterSnapshot } | null,
  next: ChapterSnapshot,
): StoredSnapshot {
  if (!previous || releaseNo === 1 || releaseNo % FULL_SNAPSHOT_EVERY === 1) {
    return { kind: 'full', snapshot: cloneSnapshot(next) };
  }

  const oldBlocks = previous.snapshot.blocks.map((block) => ({
    id: block.blockId,
    block,
  }));
  const nextBlocks = next.blocks.map((block) => ({ id: block.blockId, block }));
  const { ops, updates } = diffBlocks(oldBlocks, nextBlocks);

  const stored: StoredSnapshot = {
    kind: 'delta',
    baseReleaseNo: previous.releaseNo,
    ops,
    updates: updates.size > 0 ? Object.fromEntries(updates) : undefined,
  };
  if (previous.snapshot.title !== next.title) stored.title = next.title;
  if (previous.snapshot.intro !== next.intro) stored.intro = next.intro;
  return stored;
}

/** 深拷贝快照，避免调用方修改影响存储层对象 */
export function cloneSnapshot(snapshot: ChapterSnapshot): ChapterSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as ChapterSnapshot;
}
