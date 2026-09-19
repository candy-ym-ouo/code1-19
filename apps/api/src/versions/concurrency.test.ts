import { describe, expect, it } from 'vitest';
import {
  applyChapterDelta,
  diffChapter,
  stateHash,
  type ChapterDelta,
  type ChapterSnapshot,
  type StoredRevision,
} from './engine.js';

/**
 * 用内存存储模拟 server.ts 中发布/回滚事务的关键不变量：
 * - 章节行锁串行化并发发布与回滚
 * - 回滚的乐观版本校验 expectedChapterVersion（对应 Chapter.version）
 * - 恢复后追加新的 ROLLBACK 版本节点
 * - 协作事件 sequence 在同一事务内连续分配，冲突事务不留空洞
 */

type EventRow = { sequence: number; operation: string; revision: number };

class ChapterVersionStore {
  // Chapter.version：每次发布/回滚 +1，作为乐观锁
  private chapterVersion = 1;
  private revision = 0;
  private chain: StoredRevision[] = [];
  private events: EventRow[] = [];
  private locked = false;
  private live: ChapterSnapshot;

  constructor(initial: ChapterSnapshot) {
    this.live = initial;
  }

  publish(snapshot: ChapterSnapshot) {
    this.runExclusive(() => {
      const parent = this.chain[this.chain.length - 1] ?? null;
      const base = parent ? materializeChain(this.chain, parent.revision) : EMPTY;
      const stored: StoredRevision = {
        revision: this.revision + 1,
        deltaJson: diffChapter(base, snapshot),
        stateHash: stateHash(snapshot),
        parentStateHash: parent?.stateHash ?? null,
      };
      this.chain.push(stored);
      this.revision = stored.revision;
      this.live = snapshot;
      this.chapterVersion += 1;
      this.appendEvent('published', stored.revision);
    });
  }

  /** 模拟带乐观版本号的回滚事务。 */
  rollback(targetRevision: number, expectedChapterVersion: number) {
    this.acquireLock();
    try {
      // 乐观版本校验：必须基于调用方看到的最新章节版本
      if (this.chapterVersion !== expectedChapterVersion) {
        throw new Error(
          `CHAPTER_VERSION_CONFLICT expected=${expectedChapterVersion} current=${this.chapterVersion}`,
        );
      }

      // 重放差量重建目标版本
      const restored = materializeChain(this.chain, targetRevision);

      // 保存新的 ROLLBACK 节点，差量基线是当前线上状态
      const parent = this.chain[this.chain.length - 1];
      const rollback: StoredRevision = {
        revision: this.revision + 1,
        deltaJson: diffChapter(this.live, restored),
        stateHash: stateHash(restored),
        parentStateHash: parent.stateHash,
      };
      this.chain.push(rollback);
      this.revision = rollback.revision;
      this.live = restored;
      this.chapterVersion += 1;
      this.appendEvent('rolled_back', rollback.revision);

      return { chapterVersion: this.chapterVersion, revision: rollback.revision };
    } finally {
      this.releaseLock();
    }
  }

  get state() {
    return {
      chapterVersion: this.chapterVersion,
      revision: this.revision,
      events: [...this.events],
      live: this.live,
    };
  }

  private appendEvent(operation: string, revision: number) {
    this.events.push({ sequence: this.events.length + 1, operation, revision });
  }

  private acquireLock() {
    if (this.locked) throw new Error('LOCK_BUSY');
    this.locked = true;
  }

  private releaseLock() {
    this.locked = false;
  }

  private runExclusive(fn: () => void) {
    this.acquireLock();
    try {
      fn();
    } finally {
      this.releaseLock();
    }
  }
}

const EMPTY: ChapterSnapshot = { title: '', intro: '', blocks: [] };
const snap = (value: number): ChapterSnapshot => ({
  title: `r${value}`,
  intro: '',
  blocks: [
    { id: 'b1', type: 'p', position: '1', contentJson: { v: value }, clipId: null },
  ],
});

function materializeChain(chain: StoredRevision[], targetRevision: number): ChapterSnapshot {
  let snapshot: ChapterSnapshot = EMPTY;
  for (const stored of chain) {
    snapshot = applyChapterDelta(snapshot, stored.deltaJson as ChapterDelta);
    if (stored.revision === targetRevision) return snapshot;
  }
  throw new Error(`VERSION_NOT_FOUND ${targetRevision}`);
}

describe('concurrent rollback version checks', () => {
  it('rejects a stale rollback, accepts a refreshed one, keeps events gap-free', () => {
    const store = new ChapterVersionStore(snap(1));
    store.publish(snap(1)); // rev1, chapterVersion 2
    store.publish(snap(2)); // rev2, chapterVersion 3
    store.publish(snap(3)); // rev3, chapterVersion 4

    // 客户端 A 基于当前版本 4 回滚到 rev1
    expect(store.rollback(1, 4)).toEqual({ chapterVersion: 5, revision: 4 });

    // 客户端 B 仍持有旧版本号 4：并发回滚被版本校验拒绝
    expect(() => store.rollback(2, 4)).toThrow(/CHAPTER_VERSION_CONFLICT/);

    // B 刷新后拿到版本 5，重试回滚到 rev2 成功
    expect(store.rollback(2, 5)).toEqual({ chapterVersion: 6, revision: 5 });

    // 冲突事务未产生事件：序列 1..5 连续无空洞
    expect(store.state.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(store.state.events.map((event) => event.operation)).toEqual([
      'published',
      'published',
      'published',
      'rolled_back',
      'rolled_back',
    ]);

    // 最终线上状态等价于 rev2
    expect(store.state.live).toEqual(snap(2));
  });

  it('rolls back to an earlier revision, then re-publishes a new node', () => {
    const store = new ChapterVersionStore(snap(1));
    store.publish(snap(1)); // rev1 / chapterVersion 2
    store.publish(snap(2)); // rev2 / chapterVersion 3

    expect(store.rollback(1, 3)).toEqual({ chapterVersion: 4, revision: 3 });
    expect(store.state.live).toEqual(snap(1));

    // 回滚之后继续发布，版本链在 ROLLBACK 节点之后继续延伸
    store.publish(snap(9));
    expect(store.state.revision).toBe(4);
    expect(store.state.live).toEqual(snap(9));
    expect(store.state.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
  });

  it('rejects a rollback to an unknown revision', () => {
    const store = new ChapterVersionStore(snap(1));
    store.publish(snap(1));
    expect(() => store.rollback(99, 2)).toThrow(/VERSION_NOT_FOUND/);
  });
});
