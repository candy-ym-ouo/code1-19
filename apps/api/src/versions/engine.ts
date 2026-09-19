import crypto from 'node:crypto';

/**
 * 章节版本仓库的差量引擎。
 *
 * 每次发布生成一个版本：保存章节快照与相对上一版本的差量
 * （内容块 added / updated / removed）。回滚时按 revision 顺序
 * 重放差量，重建历史状态，再把恢复结果作为新的 ROLLBACK 版本保存。
 */

export type VersionBlock = {
  id: string;
  type: string;
  position: string;
  contentJson: unknown;
  clipId: string | null;
};

export type ChapterSnapshot = {
  title: string;
  intro: string;
  blocks: VersionBlock[];
};

export type BlockDelta = {
  added: VersionBlock[];
  updated: VersionBlock[];
  removed: string[];
};

export type ChapterDelta = {
  title: { from: string; to: string } | null;
  intro: { from: string; to: string } | null;
  blocks: BlockDelta;
};

export const EMPTY_DELTA: BlockDelta = { added: [], updated: [], removed: [] };

export function blockKey(block: Pick<VersionBlock, 'position' | 'id'>): string {
  return `${block.position}${block.id}`;
}

export function sortBlocks(blocks: VersionBlock[]): VersionBlock[] {
  return [...blocks].sort((a, b) => {
    const byPosition = a.position === b.position ? 0 : a.position < b.position ? -1 : 1;
    return byPosition !== 0 ? byPosition : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** 内容（含 position/type/clipId/contentJson）是否一致。 */
export function sameBlockContent(a: VersionBlock, b: VersionBlock): boolean {
  return (
    a.type === b.type &&
    a.position === b.position &&
    a.clipId === b.clipId &&
    canonicalJson(a.contentJson) === canonicalJson(b.contentJson)
  );
}

/**
 * 计算上一版本 -> 当前状态的内容块差量。
 * 以 block id 为匹配键：新增、内容变化、删除三类。
 */
export function diffBlocks(prev: VersionBlock[], next: VersionBlock[]): BlockDelta {
  const prevById = new Map(prev.map((block) => [block.id, block]));
  const nextById = new Map(next.map((block) => [block.id, block]));
  const added: VersionBlock[] = [];
  const updated: VersionBlock[] = [];
  const removed: string[] = [];

  for (const block of next) {
    const old = prevById.get(block.id);
    if (!old) {
      added.push(block);
    } else if (!sameBlockContent(old, block)) {
      updated.push(block);
    }
  }
  for (const block of prev) {
    if (!nextById.has(block.id)) removed.push(block.id);
  }

  return {
    added: sortBlocks(added),
    updated: sortBlocks(updated),
    removed: [...removed].sort(),
  };
}

/** 在基线上应用差量，返回按 position 排序的新状态。 */
export function applyBlockDelta(base: VersionBlock[], delta: BlockDelta): VersionBlock[] {
  const byId = new Map(base.map((block) => [block.id, block]));

  for (const id of delta.removed) byId.delete(id);
  for (const block of [...delta.added, ...delta.updated]) {
    byId.set(block.id, { ...block });
  }

  return sortBlocks([...byId.values()]);
}

export function diffChapter(prev: ChapterSnapshot, next: ChapterSnapshot): ChapterDelta {
  return {
    title: prev.title === next.title ? null : { from: prev.title, to: next.title },
    intro: prev.intro === next.intro ? null : { from: prev.intro, to: next.intro },
    blocks: diffBlocks(prev.blocks, next.blocks),
  };
}

/** 在章节快照上应用差量。 */
export function applyChapterDelta(prev: ChapterSnapshot, delta: ChapterDelta): ChapterSnapshot {
  return {
    title: delta.title ? delta.title.to : prev.title,
    intro: delta.intro ? delta.intro.to : prev.intro,
    blocks: applyBlockDelta(prev.blocks, delta.blocks),
  };
}

export function isEmptyDelta(delta: BlockDelta): boolean {
  return delta.added.length === 0 && delta.updated.length === 0 && delta.removed.length === 0;
}

export function isChapterDeltaEmpty(delta: ChapterDelta): boolean {
  return delta.title === null && delta.intro === null && isEmptyDelta(delta.blocks);
}

/** 规范化 JSON：键排序、无多余空白，保证哈希稳定。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(stableClone(value));
}

function stableClone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableClone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, stableClone((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/**
 * 计算章节状态哈希。blocks 按 position/id 规范化排序，
 * contentJson 做键排序，因此同一逻辑状态始终得到同一哈希。
 */
export function stateHash(snapshot: ChapterSnapshot): string {
  const canonical = {
    title: snapshot.title,
    intro: snapshot.intro,
    blocks: sortBlocks(snapshot.blocks).map((block) => ({
      id: block.id,
      type: block.type,
      position: block.position,
      clipId: block.clipId,
      contentJson: stableClone(block.contentJson),
    })),
  };
  return crypto.createHash('sha256').update(canonicalJson(canonical)).digest('hex');
}

export type StoredRevision = {
  revision: number;
  deltaJson: ChapterDelta;
  stateHash: string;
  parentStateHash: string | null;
};

/**
 * 从空状态开始按 revision 顺序重放差量，重建目标版本的完整状态。
 * 同时校验哈希链：任一版本的状态哈希与重放结果不一致即视为仓库损坏。
 */
export function materialize(
  revisions: StoredRevision[],
  targetRevision?: number,
): { snapshot: ChapterSnapshot; hash: string } {
  const ordered = [...revisions].sort((a, b) => a.revision - b.revision);
  const stopAt = targetRevision ?? ordered[ordered.length - 1]?.revision ?? 0;

  let snapshot: ChapterSnapshot = { title: '', intro: '', blocks: [] };
  let previousHash: string | null = null;

  for (const revision of ordered) {
    if (revision.parentStateHash !== previousHash) {
      throw new VersionIntegrityError(
        revision.revision,
        `版本 ${revision.revision} 的 parentStateHash 与重放链不一致`,
      );
    }
    snapshot = applyChapterDelta(snapshot, revision.deltaJson);
    const hash = stateHash(snapshot);
    if (hash !== revision.stateHash) {
      throw new VersionIntegrityError(
        revision.revision,
        `版本 ${revision.revision} 的状态哈希校验失败`,
      );
    }
    previousHash = hash;
    if (revision.revision === stopAt) break;
  }

  return { snapshot, hash: previousHash ?? stateHash(snapshot) };
}

export class VersionIntegrityError extends Error {
  constructor(
    public readonly revision: number,
    message: string,
  ) {
    super(message);
    this.name = 'VersionIntegrityError';
  }
}
