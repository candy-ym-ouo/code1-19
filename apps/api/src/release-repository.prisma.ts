import { Prisma, PrismaClient } from '@prisma/client';
import {
  ChapterVersionService,
  VersionStoreError,
  type ChapterHead,
  type ChapterBlockRow,
  type ChapterReleaseRecord,
  type NewEvent,
  type Tx,
  type VersionStoreContext,
} from './release-service.js';
import type { StoredSnapshot } from './version-store.js';

/**
 * 版本仓库的 Postgres/Prisma 实现。
 *
 * 每个写操作在可交互事务内先 SELECT ... FOR UPDATE 锁住章节行，
 * 同章节的发布/回滚因此天然串行；章节 version 的 CAS 作为第二道防线，
 * 防止“读旧版本→晚提交”的并发回滚覆盖。
 */
export function createChapterVersionContext(prisma: PrismaClient): {
  context: VersionStoreContext;
  service: ChapterVersionService;
} {
  const context: VersionStoreContext = {
    async run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      return prisma.$transaction(
        async (client) => fn(new PrismaTx(client)),
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 },
      );
    },
  };
  return { context, service: new ChapterVersionService(context) };
}

type DbClient = Prisma.TransactionClient;

class PrismaTx implements Tx {
  constructor(private readonly db: DbClient) {}

  async lockChapter(chapterId: string): Promise<ChapterHead | null> {
    const rows = await this.db.$queryRaw<Array<{
      id: string;
      workspace_id: string;
      title: string;
      intro: string;
      status: string;
      version: bigint;
    }>>`
      SELECT id, workspace_id, title, intro, status::text AS status, version
      FROM "Chapter"
      WHERE id = ${chapterId}
      FOR UPDATE
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      title: row.title,
      intro: row.intro,
      status: row.status,
      version: Number(row.version),
    };
  }

  async listBlocksOrdered(chapterId: string): Promise<ChapterBlockRow[]> {
    const blocks = await this.db.chapterBlock.findMany({
      where: { chapterId },
      orderBy: { position: 'asc' },
    });
    return blocks.map((block) => ({
      id: block.id,
      type: block.type,
      position: block.position,
      contentJson: block.contentJson as unknown,
      clipId: block.clipId,
    }));
  }

  async updateChapterIfVersion(input: {
    chapterId: string;
    expectedVersion: number;
    title: string;
    intro: string;
    status: string;
  }): Promise<boolean> {
    const result = await this.db.$executeRaw`
      UPDATE "Chapter"
      SET title = ${input.title},
          intro = ${input.intro},
          status = ${input.status}::"ChapterStatus",
          version = version + 1,
          "updatedAt" = NOW()
      WHERE id = ${input.chapterId} AND version = ${input.expectedVersion}
    `;
    return result > 0;
  }

  async getLatestRelease(chapterId: string): Promise<ChapterReleaseRecord | null> {
    const row = await this.db.chapterRelease.findFirst({
      where: { chapterId },
      orderBy: { releaseNo: 'desc' },
    });
    return row ? toReleaseRecord(row) : null;
  }

  async getRelease(
    chapterId: string,
    releaseNo: number,
  ): Promise<ChapterReleaseRecord | null> {
    const row = await this.db.chapterRelease.findUnique({
      where: { chapterId_releaseNo: { chapterId, releaseNo } },
    });
    return row ? toReleaseRecord(row) : null;
  }

  async insertRelease(
    release: Omit<ChapterReleaseRecord, 'id' | 'createdAt'>,
  ): Promise<ChapterReleaseRecord> {
    const row = await this.db.chapterRelease.create({
      data: {
        chapterId: release.chapterId,
        releaseNo: release.releaseNo,
        kind: release.kind,
        rolledBackToNo: release.rolledBackToNo,
        snapshotKind: release.snapshot.kind,
        baseReleaseNo:
          release.snapshot.kind === 'delta'
            ? release.snapshot.baseReleaseNo
            : null,
        snapshotJson: release.snapshot as Prisma.InputJsonValue,
        actorId: release.actorId,
        note: release.note,
      },
    });
    return toReleaseRecord(row);
  }

  async filterExistingClipIds(
    workspaceId: string,
    clipIds: string[],
  ): Promise<Set<string>> {
    if (clipIds.length === 0) return new Set();
    const rows = await this.db.clip.findMany({
      where: { id: { in: clipIds }, workspaceId, deletedAt: null },
      select: { id: true },
    });
    return new Set(rows.map((row) => row.id));
  }

  async updateBlock(input: {
    id: string;
    type: string;
    position: string;
    contentJson: unknown;
    clipId: string | null;
  }): Promise<void> {
    await this.db.chapterBlock.update({
      where: { id: input.id },
      data: {
        type: input.type,
        position: input.position,
        contentJson: input.contentJson as Prisma.InputJsonValue,
        clipId: input.clipId,
      },
    });
  }

  async createBlock(input: {
    id: string;
    chapterId: string;
    type: string;
    position: string;
    contentJson: unknown;
    clipId: string | null;
  }): Promise<void> {
    await this.db.chapterBlock.create({
      data: {
        id: input.id,
        chapterId: input.chapterId,
        type: input.type,
        position: input.position,
        contentJson: input.contentJson as Prisma.InputJsonValue,
        clipId: input.clipId,
      },
    });
  }

  async deleteBlocks(blockIds: string[]): Promise<void> {
    if (blockIds.length === 0) return;
    await this.db.chapterBlock.deleteMany({ where: { id: { in: blockIds } } });
  }

  async appendEvent(event: NewEvent): Promise<number> {
    const row = await this.db.collaborationEvent.create({
      data: {
        workspaceId: event.workspaceId,
        actorId: event.actorId,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        operation: event.operation,
        payloadJson: event.payloadJson as Prisma.InputJsonValue,
      },
    });
    return row.sequence;
  }
}

type ChapterReleasePrismaRow = {
  id: string;
  chapterId: string;
  releaseNo: number;
  kind: 'PUBLISH' | 'ROLLBACK';
  rolledBackToNo: number | null;
  snapshotKind: string;
  snapshotJson: Prisma.JsonValue;
  actorId: string;
  note: string | null;
  createdAt: Date;
};

function toReleaseRecord(row: ChapterReleasePrismaRow): ChapterReleaseRecord {
  return {
    id: row.id,
    chapterId: row.chapterId,
    releaseNo: row.releaseNo,
    kind: row.kind,
    rolledBackToNo: row.rolledBackToNo,
    actorId: row.actorId,
    note: row.note,
    createdAt: row.createdAt,
    snapshot: row.snapshotJson as unknown as StoredSnapshot,
  };
}

export { VersionStoreError };
