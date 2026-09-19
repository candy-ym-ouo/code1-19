import crypto from 'node:crypto';
import {
  ChapterVersionService,
  type ChapterBlockRow,
  type ChapterHead,
  type ChapterReleaseRecord,
  type NewEvent,
  type Tx,
  type VersionStoreContext,
} from './release-service.js';

/**
 * 版本仓库的内存实现，与 Prisma/Postgres 实现同一 Tx 契约：
 * - 每章节一把互斥锁模拟 SELECT ... FOR UPDATE 的串行效果；
 * - version CAS 模拟 UPDATE ... WHERE version = ?；
 * - 协作事件按提交顺序分配连续的 workspace 级 sequence。
 */
export type MemoryClip = { id: string; workspaceId: string; deletedAt: Date | null };

export class MemoryVersionStore {
  readonly chapters = new Map<string, ChapterHead>();
  readonly blocks = new Map<string, ChapterBlockRow & { chapterId: string }>();
  readonly releases = new Map<string, ChapterReleaseRecord[]>();
  readonly events: Array<NewEvent & { sequence: number; at: number }> = [];
  readonly clips = new Map<string, MemoryClip>();
  private readonly locks = new Map<string, Promise<unknown>>();
  eventCursor = 0;

  addChapter(chapter: ChapterHead): void {
    this.chapters.set(chapter.id, { ...chapter });
  }

  addBlock(block: ChapterBlockRow & { chapterId: string }): void {
    this.blocks.set(block.id, structuredClone(block));
  }

  addClip(clip: MemoryClip): void {
    this.clips.set(clip.id, { ...clip });
  }

  service(chapterId: string): ChapterVersionService {
    return new ChapterVersionService(this.forChapter(chapterId));
  }

  forChapter(chapterId: string): VersionStoreContext {
    const store = this;
    return {
      run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
        return store.withChapterLock(chapterId, () => fn(new MemoryTx(store)));
      },
    };
  }

  private withChapterLock<T>(chapterId: string, work: () => Promise<T>): Promise<T> {
    if (!chapterId) throw new Error('内存事务需要通过 forChapter 指定章节');
    const previous = this.locks.get(chapterId) ?? Promise.resolve();
    let release: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.then(() => gate);
    this.locks.set(chapterId, next);
    return previous.then(async () => {
      try {
        return await work();
      } finally {
        release!();
      }
    });
  }

  chapterBlocks(chapterId: string): ChapterBlockRow[] {
    return [...this.blocks.values()]
      .filter((block) => block.chapterId === chapterId)
      .sort((a, b) => a.position.localeCompare(b.position))
      .map(({ chapterId: _chapterId, ...block }) => block);
  }
}

class MemoryTx implements Tx {
  constructor(private readonly store: MemoryVersionStore) {}

  async lockChapter(chapterId: string): Promise<ChapterHead | null> {
    const chapter = this.store.chapters.get(chapterId);
    return chapter ? { ...chapter } : null;
  }

  async listBlocksOrdered(chapterId: string): Promise<ChapterBlockRow[]> {
    return this.store.chapterBlocks(chapterId);
  }

  async updateChapterIfVersion(input: {
    chapterId: string;
    expectedVersion: number;
    title: string;
    intro: string;
    status: string;
  }): Promise<boolean> {
    const chapter = this.store.chapters.get(input.chapterId);
    if (!chapter || chapter.version !== input.expectedVersion) return false;
    chapter.title = input.title;
    chapter.intro = input.intro;
    chapter.status = input.status;
    chapter.version += 1;
    return true;
  }

  async getLatestRelease(chapterId: string): Promise<ChapterReleaseRecord | null> {
    const list = this.store.releases.get(chapterId);
    return list && list.length > 0 ? structuredClone(list[list.length - 1]) : null;
  }

  async getRelease(
    chapterId: string,
    releaseNo: number,
  ): Promise<ChapterReleaseRecord | null> {
    const found = this.store.releases.get(chapterId)?.find((item) => item.releaseNo === releaseNo);
    return found ? structuredClone(found) : null;
  }

  async insertRelease(
    release: Omit<ChapterReleaseRecord, 'id' | 'createdAt'>,
  ): Promise<ChapterReleaseRecord> {
    const record: ChapterReleaseRecord = {
      ...release,
      id: crypto.randomUUID(),
      createdAt: new Date(),
    };
    const list = this.store.releases.get(release.chapterId) ?? [];
    list.push(structuredClone(record));
    this.store.releases.set(release.chapterId, list);
    return record;
  }

  async filterExistingClipIds(
    workspaceId: string,
    clipIds: string[],
  ): Promise<Set<string>> {
    return new Set(
      clipIds.filter((clipId) => {
        const clip = this.store.clips.get(clipId);
        return clip?.workspaceId === workspaceId && clip.deletedAt === null;
      }),
    );
  }

  async updateBlock(input: {
    id: string;
    type: string;
    position: string;
    contentJson: unknown;
    clipId: string | null;
  }): Promise<void> {
    const block = this.store.blocks.get(input.id);
    if (!block) throw new Error(`块 ${input.id} 不存在`);
    Object.assign(block, input);
  }

  async createBlock(input: {
    id: string;
    chapterId: string;
    type: string;
    position: string;
    contentJson: unknown;
    clipId: string | null;
  }): Promise<void> {
    this.store.blocks.set(input.id, structuredClone(input));
  }

  async deleteBlocks(blockIds: string[]): Promise<void> {
    for (const id of blockIds) this.store.blocks.delete(id);
  }

  async appendEvent(event: NewEvent): Promise<number> {
    this.store.eventCursor += 1;
    this.store.events.push({ ...event, sequence: this.store.eventCursor, at: this.store.events.length });
    return this.store.eventCursor;
  }
}
