import {
  buildReleaseSnapshot,
  resolveSnapshot,
  type BlockSnapshot,
  type ChapterSnapshot,
  type StoredSnapshot,
  FULL_SNAPSHOT_EVERY,
} from './version-store.js';

/**
 * 章节版本仓库服务：按发布节点保存全量/差量快照，支持乐观锁回滚。
 *
 * 设计要点：
 * - 发布历史 append-only，每个发布节点有章节内单调递增的 releaseNo；
 * - 首个节点与每 FULL_SNAPSHOT_EVERY 个节点落全量快照，其余节点只存与
 *   上一节点的差量（LCS 编辑脚本），差量链最多回溯 FULL_SNAPSHOT_EVERY-1 级；
 * - 回滚不删除、不改写历史，而是追加一个 kind=ROLLBACK 的新发布节点，
 *   并写入 chapter.rolledBack 协作事件 —— 事件日志因此保持连续；
 * - 所有写操作在存储层事务内先对章节行加锁，再用
 *   (chapterId, expectedVersion) 比较并设置（CAS）：并发回滚/发布串行化，
 *   版本不匹配的一方拿到 VERSION_CONFLICT 后由调用方重试或报 409。
 */

export type ReleaseKind = 'PUBLISH' | 'ROLLBACK';

export type ChapterReleaseRecord = {
  id: string;
  chapterId: string;
  releaseNo: number;
  kind: ReleaseKind;
  /** ROLLBACK 节点指向恢复目标的发布号；PUBLISH 节点为 null */
  rolledBackToNo: number | null;
  actorId: string;
  note: string | null;
  snapshot: StoredSnapshot;
  createdAt: Date;
};

export type ChapterHead = {
  id: string;
  workspaceId: string;
  title: string;
  intro: string;
  status: string;
  version: number;
};

export type ChapterBlockRow = {
  id: string;
  type: string;
  position: string;
  contentJson: unknown;
  clipId: string | null;
};

export type RestorePlan = {
  chapter: ChapterHead;
  target: ChapterReleaseRecord;
  snapshot: ChapterSnapshot;
  /** 现存块：命中快照 blockId 的就地更新，快照中缺失的块新建 */
  blocksToRestore: Array<{ existingId: string | null; snapshot: BlockSnapshot }>;
  /** 快照里不存在的现存块，回滚时删除 */
  blockIdsToDelete: string[];
  /** 快照引用但已不存在的 clipId，恢复时置空 */
  missingClipIds: string[];
};

export type NewEvent = {
  workspaceId: string;
  actorId: string;
  resourceType: 'chapter';
  resourceId: string;
  operation: string;
  payloadJson: unknown;
};

export type PublishInput = {
  chapterId: string;
  actorId: string;
  /** 传入时进行 CAS 校验 */
  expectedVersion?: number;
  note?: string | null;
};

export type RollbackInput = {
  chapterId: string;
  actorId: string;
  /** 必填：回滚到的发布节点号 */
  targetReleaseNo: number;
  /** 必填：客户端读到的章节 version，乐观锁防并发覆盖 */
  expectedVersion: number;
  note?: string | null;
};

export type PublishResult = {
  chapter: ChapterHead;
  release: ChapterReleaseRecord;
};

export class VersionStoreError extends Error {
  constructor(
    public readonly code:
      | 'VERSION_CONFLICT'
      | 'RELEASE_NOT_FOUND'
      | 'NO_PUBLISHED_RELEASE'
      | 'INVALID_ROLLBACK_TARGET'
      | 'CHAPTER_NOT_FOUND'
      | 'EMPTY_CHAPTER',
    message: string,
  ) {
    super(message);
    this.name = 'VersionStoreError';
  }
}

/**
 * 存储层事务接口。Postgres 实现见 release-repository.prisma.ts；
 * 内存实现见测试，二者跑同一套服务逻辑以验证并发与事件连续性。
 */
export interface Tx {
  /** SELECT ... FOR UPDATE 后读取章节头；不存在返回 null */
  lockChapter(chapterId: string): Promise<ChapterHead | null>;
  listBlocksOrdered(chapterId: string): Promise<ChapterBlockRow[]>;
  /** CAS 更新章节头；返回是否命中版本 */
  updateChapterIfVersion(input: {
    chapterId: string;
    expectedVersion: number;
    title: string;
    intro: string;
    status: string;
  }): Promise<boolean>;
  getLatestRelease(chapterId: string): Promise<ChapterReleaseRecord | null>;
  getRelease(chapterId: string, releaseNo: number): Promise<ChapterReleaseRecord | null>;
  /** 插入发布节点并返回带 id/createdAt 的完整记录 */
  insertRelease(
    release: Omit<ChapterReleaseRecord, 'id' | 'createdAt'>,
  ): Promise<ChapterReleaseRecord>;
  /** 给定 clipId 集合，返回仍然存在（未删除）的 clipId */
  filterExistingClipIds(workspaceId: string, clipIds: string[]): Promise<Set<string>>;
  updateBlock(input: {
    id: string;
    type: string;
    position: string;
    contentJson: unknown;
    clipId: string | null;
  }): Promise<void>;
  createBlock(input: {
    id: string;
    chapterId: string;
    type: string;
    position: string;
    contentJson: unknown;
    clipId: string | null;
  }): Promise<void>;
  deleteBlocks(blockIds: string[]): Promise<void>;
  appendEvent(event: NewEvent): Promise<number>;
}

export interface VersionStoreContext {
  /** 串行化事务：Postgres 实现为事务内锁章节行，内存实现为每章节互斥 */
  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export function snapshotFromChapter(
  chapter: Pick<ChapterHead, 'title' | 'intro'>,
  blocks: ChapterBlockRow[],
): ChapterSnapshot {
  const ordered = [...blocks].sort((a, b) => a.position.localeCompare(b.position));
  return {
    title: chapter.title,
    intro: chapter.intro,
    blocks: ordered.map((block) => ({
      blockId: block.id,
      blockType: block.type,
      position: block.position,
      contentJson: block.contentJson,
      clipId: block.clipId,
    })),
  };
}

export async function resolveRelease(
  tx: Tx,
  chapterId: string,
  releaseNo: number,
): Promise<{ record: ChapterReleaseRecord; snapshot: ChapterSnapshot } | null> {
  const record = await tx.getRelease(chapterId, releaseNo);
  if (!record) return null;
  const snapshot = await resolveSnapshot(record.snapshot, async (no) => {
    const previous = await tx.getRelease(chapterId, no);
    if (!previous) {
      throw new Error(`发布节点 ${releaseNo} 的差量基准 ${no} 缺失，快照链断裂`);
    }
    return previous.snapshot;
  });
  return { record, snapshot };
}

/** 计算回滚恢复计划（纯计算，不写库），供服务层与测试复用 */
export async function planRollback(
  tx: Tx,
  chapter: ChapterHead,
  targetReleaseNo: number,
): Promise<RestorePlan> {
  const resolved = await resolveRelease(tx, chapter.id, targetReleaseNo);
  if (!resolved) {
    throw new VersionStoreError(
      'RELEASE_NOT_FOUND',
      `发布节点 r${targetReleaseNo} 不存在`,
    );
  }

  const { target, snapshot } = {
    target: resolved.record,
    snapshot: resolved.snapshot,
  };

  const currentBlocks = await tx.listBlocksOrdered(chapter.id);
  const currentById = new Map(currentBlocks.map((block) => [block.id, block]));
  const snapshotIds = new Set(snapshot.blocks.map((block) => block.blockId));

  const referencedClipIds = [
    ...new Set(
      snapshot.blocks
        .map((block) => block.clipId)
        .filter((clipId): clipId is string => clipId !== null),
    ),
  ];
  const existingClips =
    referencedClipIds.length > 0
      ? await tx.filterExistingClipIds(chapter.workspaceId, referencedClipIds)
      : new Set<string>();
  const missingClipIds = referencedClipIds.filter((clipId) => !existingClips.has(clipId));
  const missingClipSet = new Set(missingClipIds);

  const blocksToRestore = snapshot.blocks.map((block) => ({
    existingId: currentById.has(block.blockId) ? block.blockId : null,
    snapshot: missingClipSet.has(block.clipId ?? '')
      ? { ...block, clipId: null }
      : block,
  }));

  const blockIdsToDelete = currentBlocks
    .filter((block) => !snapshotIds.has(block.id))
    .map((block) => block.id);

  return { chapter, target, snapshot, blocksToRestore, blockIdsToDelete, missingClipIds };
}

export class ChapterVersionService {
  constructor(private readonly context: VersionStoreContext) {}

  /** 在发布节点保存快照；首个/每 3 个节点全量，其余差量 */
  async publish(input: PublishInput): Promise<PublishResult> {
    return this.context.run(async (tx) => {
      const chapter = await tx.lockChapter(input.chapterId);
      if (!chapter) {
        throw new VersionStoreError('CHAPTER_NOT_FOUND', '章节不存在');
      }
      if (
        input.expectedVersion !== undefined &&
        chapter.version !== input.expectedVersion
      ) {
        throw new VersionStoreError(
          'VERSION_CONFLICT',
          `版本不匹配：客户端 r${input.expectedVersion}，服务端 r${chapter.version}`,
        );
      }

      const blocks = await tx.listBlocksOrdered(chapter.id);
      if (blocks.length === 0) {
        throw new VersionStoreError('EMPTY_CHAPTER', '章节至少需要一个内容块');
      }

      const latest = await tx.getLatestRelease(chapter.id);
      const nextReleaseNo = (latest?.releaseNo ?? 0) + 1;
      const currentSnapshot = snapshotFromChapter(chapter, blocks);
      const previous = latest
        ? {
            releaseNo: latest.releaseNo,
            snapshot: await resolveSnapshot(latest.snapshot, async (no) => {
              const previousRecord = await tx.getRelease(chapter.id, no);
              if (!previousRecord) {
                throw new Error(`差量基准节点 r${no} 缺失`);
              }
              return previousRecord.snapshot;
            }),
          }
        : null;

      const storedSnapshot = buildReleaseSnapshot(nextReleaseNo, previous, currentSnapshot);

      const updated = await tx.updateChapterIfVersion({
        chapterId: chapter.id,
        expectedVersion: chapter.version,
        title: chapter.title,
        intro: chapter.intro,
        status: 'PUBLISHED',
      });
      if (!updated) {
        throw new VersionStoreError('VERSION_CONFLICT', '章节版本已被并发修改');
      }

      const release: Omit<ChapterReleaseRecord, 'id' | 'createdAt'> = {
        chapterId: chapter.id,
        releaseNo: nextReleaseNo,
        kind: 'PUBLISH',
        rolledBackToNo: null,
        actorId: input.actorId,
        note: input.note ?? null,
        snapshot: storedSnapshot,
      };
      const savedRelease = await tx.insertRelease(release);
      await tx.appendEvent({
        workspaceId: chapter.workspaceId,
        actorId: input.actorId,
        resourceType: 'chapter',
        resourceId: chapter.id,
        operation: 'published',
        payloadJson: {
          releaseNo: nextReleaseNo,
          snapshotKind: storedSnapshot.kind,
          baseReleaseNo:
            storedSnapshot.kind === 'delta' ? storedSnapshot.baseReleaseNo : null,
          version: chapter.version + 1,
        },
      });

      return {
        chapter: { ...chapter, status: 'PUBLISHED', version: chapter.version + 1 },
        release: savedRelease,
      };
    });
  }

  /**
   * 回滚到指定发布节点：版本校验通过后按计划恢复标题/导语/块集合，
   * 追加 ROLLBACK 发布节点（快照为恢复后的全量）与 rolledBack 事件。
   */
  async rollback(input: RollbackInput): Promise<{
    chapter: ChapterHead;
    release: ChapterReleaseRecord;
    plan: RestorePlan;
  }> {
    return this.context.run(async (tx) => {
      const chapter = await tx.lockChapter(input.chapterId);
      if (!chapter) {
        throw new VersionStoreError('CHAPTER_NOT_FOUND', '章节不存在');
      }
      if (chapter.version !== input.expectedVersion) {
        throw new VersionStoreError(
          'VERSION_CONFLICT',
          `版本不匹配：客户端 r${input.expectedVersion}，服务端 r${chapter.version}`,
        );
      }

      const latest = await tx.getLatestRelease(chapter.id);
      if (!latest) {
        throw new VersionStoreError('NO_PUBLISHED_RELEASE', '章节尚未发布，无可回滚节点');
      }
      if (input.targetReleaseNo > latest.releaseNo) {
        throw new VersionStoreError(
          'RELEASE_NOT_FOUND',
          `发布节点 r${input.targetReleaseNo} 不存在`,
        );
      }

      const plan = await planRollback(tx, chapter, input.targetReleaseNo);

      // 先删后建/改，保证恢复后的块顺序与快照一致
      if (plan.blockIdsToDelete.length > 0) {
        await tx.deleteBlocks(plan.blockIdsToDelete);
      }
      for (const item of plan.blocksToRestore) {
        if (item.existingId) {
          await tx.updateBlock({
            id: item.existingId,
            type: item.snapshot.blockType,
            position: item.snapshot.position,
            contentJson: item.snapshot.contentJson,
            clipId: item.snapshot.clipId,
          });
        } else {
          await tx.createBlock({
            id: item.snapshot.blockId,
            chapterId: chapter.id,
            type: item.snapshot.blockType,
            position: item.snapshot.position,
            contentJson: item.snapshot.contentJson,
            clipId: item.snapshot.clipId,
          });
        }
      }

      const updated = await tx.updateChapterIfVersion({
        chapterId: chapter.id,
        expectedVersion: chapter.version,
        title: plan.snapshot.title,
        intro: plan.snapshot.intro,
        // 回滚恢复内容但状态保持已发布
        status: 'PUBLISHED',
      });
      if (!updated) {
        throw new VersionStoreError('VERSION_CONFLICT', '章节版本已被并发修改');
      }

      // 回滚节点的快照是恢复结果。它本身可能是全量（差量链的新基准），
      // 按发布序号的周期规则处理：回滚后内容大变，强制全量最稳妥。
      const nextReleaseNo = latest.releaseNo + 1;
      const storedSnapshot = buildRollbackSnapshot(nextReleaseNo, plan.snapshot);
      const release: Omit<ChapterReleaseRecord, 'id' | 'createdAt'> = {
        chapterId: chapter.id,
        releaseNo: nextReleaseNo,
        kind: 'ROLLBACK',
        rolledBackToNo: plan.target.releaseNo,
        actorId: input.actorId,
        note: input.note ?? null,
        snapshot: storedSnapshot,
      };
      const savedRelease = await tx.insertRelease(release);
      await tx.appendEvent({
        workspaceId: chapter.workspaceId,
        actorId: input.actorId,
        resourceType: 'chapter',
        resourceId: chapter.id,
        operation: 'rolledBack',
        payloadJson: {
          releaseNo: nextReleaseNo,
          rolledBackToNo: plan.target.releaseNo,
          restoredBlocks: plan.blocksToRestore.length,
          deletedBlocks: plan.blockIdsToDelete.length,
          missingClipIds: plan.missingClipIds,
          version: chapter.version + 1,
        },
      });

      return {
        chapter: {
          ...chapter,
          title: plan.snapshot.title,
          intro: plan.snapshot.intro,
          status: 'PUBLISHED',
          version: chapter.version + 1,
        },
        release: savedRelease,
        plan,
      };
    });
  }
}

/** 回滚节点强制全量：它成为后续差量链的明确新基准，避免跨历史分叉引用 */
export function buildRollbackSnapshot(
  releaseNo: number,
  snapshot: ChapterSnapshot,
): StoredSnapshot {
  void releaseNo;
  return { kind: 'full', snapshot: structuredClone(snapshot) };
}

export { FULL_SNAPSHOT_EVERY };
