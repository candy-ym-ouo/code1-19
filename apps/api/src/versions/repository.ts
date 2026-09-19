import type { Prisma, PrismaClient } from '@prisma/client';
import {
  diffChapter,
  isChapterDeltaEmpty,
  materialize,
  stateHash,
  type ChapterDelta,
  type ChapterSnapshot,
  type StoredRevision,
  type VersionBlock,
  VersionIntegrityError,
} from './engine.js';

type DbClient = PrismaClient | Prisma.TransactionClient;

export class VersionConflictError extends Error {
  constructor(
    public readonly code:
      | 'CHAPTER_VERSION_CONFLICT'
      | 'VERSION_REVISION_CONFLICT'
      | 'VERSION_NOT_FOUND'
      | 'NO_CHANGES_TO_PUBLISH',
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'VersionConflictError';
  }
}

export type ChapterVersionSummary = {
  id: string;
  chapterId: string;
  revision: number;
  kind: 'PUBLISH' | 'ROLLBACK';
  title: string;
  intro: string;
  parentStateHash: string | null;
  stateHash: string;
  restoredFromRevision: number | null;
  createdById: string;
  createdAt: Date;
};

export function toVersionSummary(row: {
  id: string;
  chapterId: string;
  revision: number;
  kind: 'PUBLISH' | 'ROLLBACK';
  title: string;
  intro: string;
  parentStateHash: string | null;
  stateHash: string;
  restoredFromRevision: number | null;
  createdById: string;
  createdAt: Date;
}): ChapterVersionSummary {
  return {
    id: row.id,
    chapterId: row.chapterId,
    revision: row.revision,
    kind: row.kind,
    title: row.title,
    intro: row.intro,
    parentStateHash: row.parentStateHash,
    stateHash: row.stateHash,
    restoredFromRevision: row.restoredFromRevision,
    createdById: row.createdById,
    createdAt: row.createdAt,
  };
}

export async function listChapterVersions(
  db: DbClient,
  chapterId: string,
): Promise<ChapterVersionSummary[]> {
  const rows = await db.chapterVersion.findMany({
    where: { chapterId },
    orderBy: { revision: 'desc' },
  });
  return rows.map(toVersionSummary);
}

/**
 * 按发布节点保存差量快照：在已持有章节行锁的事务中调用。
 * 返回新版本；与最新版本内容完全一致时抛 NO_CHANGES_TO_PUBLISH。
 */
export async function savePublishSnapshot(args: {
  db: DbClient;
  chapter: { id: string; workspaceId: string; title: string; intro: string };
  blocks: Array<{
    id: string;
    type: string;
    position: string;
    contentJson: unknown;
    clipId: string | null;
  }>;
  createdById: string;
}): Promise<ChapterVersionSummary> {
  const { db, chapter, blocks, createdById } = args;

  const previous = await db.chapterVersion.findFirst({
    where: { chapterId: chapter.id },
    orderBy: { revision: 'desc' },
  });

  const next: ChapterSnapshot = {
    title: chapter.title,
    intro: chapter.intro,
    blocks: blocks.map(toVersionBlock),
  };

  let parentStateHash: string | null = null;
  let delta: ChapterDelta;
  if (previous) {
    parentStateHash = previous.stateHash;
    // 加载完整差量链重放最新版本状态，作为本次发布的差量基线
    const rows = await db.chapterVersion.findMany({
      where: { chapterId: chapter.id, revision: { lte: previous.revision } },
      orderBy: { revision: 'asc' },
    });
    const { snapshot } = materialize(
      rows.map((row) => ({
        revision: row.revision,
        deltaJson: row.deltaJson as ChapterDelta,
        stateHash: row.stateHash,
        parentStateHash: row.parentStateHash,
      })),
    );
    delta = diffChapter(snapshot, next);
    if (isChapterDeltaEmpty(delta)) {
      throw new VersionConflictError(
        'NO_CHANGES_TO_PUBLISH',
        '章节内容与上一发布版本一致，无需再次发布',
      );
    }
  } else {
    // 首个版本：相对空状态的差量
    delta = diffChapter({ title: '', intro: '', blocks: [] }, next);
  }

  const hash = stateHash(next);
  const revision = (previous?.revision ?? 0) + 1;

  try {
    const created = await db.chapterVersion.create({
      data: {
        chapterId: chapter.id,
        workspaceId: chapter.workspaceId,
        revision,
        kind: 'PUBLISH',
        title: chapter.title,
        intro: chapter.intro,
        deltaJson: delta as Prisma.InputJsonValue,
        stateHash: hash,
        parentStateHash,
        createdById,
      },
    });
    return toVersionSummary(created);
  } catch (error) {
    // 并发发布导致 (chapterId, revision) 唯一冲突
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'P2002'
    ) {
      throw new VersionConflictError(
        'VERSION_REVISION_CONFLICT',
        '发布版本冲突，请重试',
      );
    }
    throw error;
  }
}

/**
 * 重放差量重建指定 revision 的完整章节状态。
 * 目标版本不存在或哈希链损坏时抛错。
 */
export async function loadSnapshotAt(
  db: DbClient,
  chapterId: string,
  revision: number,
): Promise<{ snapshot: ChapterSnapshot; stateHash: string; target: StoredRevision }> {
  const rows = await db.chapterVersion.findMany({
    where: { chapterId, revision: { lte: revision } },
    orderBy: { revision: 'asc' },
  });
  if (rows.length === 0 || rows[rows.length - 1].revision !== revision) {
    throw new VersionConflictError(
      'VERSION_NOT_FOUND',
      `版本 ${revision} 不存在`,
      { revision },
    );
  }
  const revisions: StoredRevision[] = rows.map((row) => ({
    revision: row.revision,
    deltaJson: row.deltaJson as ChapterDelta,
    stateHash: row.stateHash,
    parentStateHash: row.parentStateHash,
  }));
  try {
    const { snapshot, hash } = materialize(revisions, revision);
    return { snapshot, stateHash: hash, target: revisions[revisions.length - 1] };
  } catch (error) {
    if (error instanceof VersionIntegrityError) {
      throw new VersionConflictError(
        'VERSION_NOT_FOUND',
        `版本仓库完整性校验失败：${error.message}`,
        { revision: error.revision },
      );
    }
    throw error;
  }
}

/**
 * 把回滚恢复出的状态保存为新的 ROLLBACK 版本。
 * delta 为当前最新版本状态 -> 恢复状态的差量。
 */
export async function saveRollbackSnapshot(args: {
  db: DbClient;
  chapter: { id: string; workspaceId: string };
  restored: ChapterSnapshot;
  current: ChapterSnapshot;
  restoredFromRevision: number;
  createdById: string;
}): Promise<ChapterVersionSummary> {
  const { db, chapter, restored, current, restoredFromRevision, createdById } = args;
  const previous = await db.chapterVersion.findFirstOrThrow({
    where: { chapterId: chapter.id },
    orderBy: { revision: 'desc' },
  });

  const delta = diffChapter(current, restored);
  const created = await db.chapterVersion.create({
    data: {
      chapterId: chapter.id,
      workspaceId: chapter.workspaceId,
      revision: previous.revision + 1,
      kind: 'ROLLBACK',
      title: restored.title,
      intro: restored.intro,
      deltaJson: delta as Prisma.InputJsonValue,
      stateHash: stateHash(restored),
      parentStateHash: previous.stateHash,
      restoredFromRevision,
      createdById,
    },
  });
  return toVersionSummary(created);
}

function toVersionBlock(block: {
  id: string;
  type: string;
  position: string;
  contentJson: unknown;
  clipId: string | null;
}): VersionBlock {
  return {
    id: block.id,
    type: block.type,
    position: block.position,
    contentJson: block.contentJson,
    clipId: block.clipId,
  };
}
