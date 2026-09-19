import { describe, expect, it } from 'vitest';
import {
  buildReleaseSnapshot,
  diffBlocks,
  FULL_SNAPSHOT_EVERY,
  isBlockSnapshotEqual,
  patchBlocks,
  resolveSnapshot,
  type BlockSnapshot,
  type ChapterSnapshot,
} from './version-store.js';

function block(
  id: string,
  text: string,
  extra?: Partial<BlockSnapshot>,
): { id: string; block: BlockSnapshot } {
  return {
    id,
    block: {
      blockId: id,
      blockType: 'paragraph',
      position: id,
      contentJson: { text },
      clipId: null,
      ...extra,
    },
  };
}

function snapshot(texts: string[]): ChapterSnapshot {
  return {
    title: 't',
    intro: '',
    blocks: texts.map((text, index) => block(`b${index}`, text).block),
  };
}

describe('diffBlocks / patchBlocks', () => {
  it('插入、删除、重排和就地更新都能往返还原', () => {
    const old = [block('a', 'A'), block('b', 'B'), block('c', 'C')];
    const next = [
      block('a', 'A2'), // 就地更新
      block('x', 'X'), // 插入
      block('c', 'C'), // b 被删除，c 保留
    ];

    const { ops, updates } = diffBlocks(old, next);
    const restored = patchBlocks(old, ops, updates);
    expect(restored).toEqual(next.map((item) => item.block));
  });

  it('完全替换的序列不会保留任何旧块', () => {
    const old = [block('a', 'A')];
    const next = [block('z', 'Z')];
    const { ops, updates } = diffBlocks(old, next);
    expect(patchBlocks(old, ops, updates)).toEqual([next[0].block]);
  });

  it('脚本越界或不完整时抛出，防止静默损坏快照', () => {
    const old = [block('a', 'A')];
    expect(() =>
      patchBlocks(old, [{ type: 'retain', count: 2 }], new Map()),
    ).toThrow(/越界/);
    expect(() =>
      patchBlocks(old, [], new Map()),
    ).toThrow(/不完整/);
  });

  it('内容 JSON 按键排序后比较，键序不同不算更新', () => {
    const a = block('a', '', { contentJson: { x: 1, y: 2 } }).block;
    const b = { ...a, contentJson: { y: 2, x: 1 } };
    expect(isBlockSnapshotEqual(a, b)).toBe(true);
  });
});

describe('buildReleaseSnapshot / resolveSnapshot', () => {
  it('首个节点和周期节点为全量，中间节点为差量', () => {
    const releases: Array<{ no: number; stored: ReturnType<typeof buildReleaseSnapshot> }> = [];
    let previous: { releaseNo: number; snapshot: ChapterSnapshot } | null = null;

    for (let no = 1; no <= 7; no += 1) {
      const next = snapshot(Array.from({ length: no }, (_, index) => `v${no}-${index}`));
      const stored = buildReleaseSnapshot(no, previous, next);
      releases.push({ no, stored });
      previous = { releaseNo: no, snapshot: next };
    }

    const fullNumbers = releases
      .filter((item) => item.stored.kind === 'full')
      .map((item) => item.no);
    expect(fullNumbers).toEqual(
      Array.from(
        { length: Math.ceil(7 / FULL_SNAPSHOT_EVERY) },
        (_, index) => index * FULL_SNAPSHOT_EVERY + 1,
      ),
    );
  });

  it('沿差量链还原任意发布节点，内容与当时快照一致', async () => {
    const states: ChapterSnapshot[] = [];
    const stored: ReturnType<typeof buildReleaseSnapshot>[] = [];
    let previous: { releaseNo: number; snapshot: ChapterSnapshot } | null = null;

    const versions: ChapterSnapshot[] = [
      {
        title: '标题1',
        intro: '导语',
        blocks: [block('b1', '一').block, block('b2', '二').block],
      },
      {
        title: '标题2',
        intro: '导语',
        blocks: [block('b1', '一').block, block('b3', '三').block],
      },
      {
        title: '标题2',
        intro: '导语',
        blocks: [
          block('b3', '三').block,
          block('b1', '一改').block,
          block('b4', '四').block,
        ],
      },
      {
        title: '标题3',
        intro: '导语改',
        blocks: [block('b4', '四').block],
      },
    ];

    versions.forEach((next, index) => {
      const no = index + 1;
      states.push(next);
      const snapshot = buildReleaseSnapshot(no, previous, next);
      stored.push(snapshot);
      previous = { releaseNo: no, snapshot: next };
    });

    const load = async (releaseNo: number) => stored[releaseNo - 1];
    for (let no = 1; no <= versions.length; no += 1) {
      const resolved = await resolveSnapshot(stored[no - 1], load);
      expect(resolved).toEqual(states[no - 1]);
    }
  });

  it('差量只在头部字段变化时携带 title/intro', () => {
    const r1 = snapshot(['a']);
    const r2: ChapterSnapshot = { ...r1, blocks: [block('b0', 'changed').block] };
    const delta = buildReleaseSnapshot(2, { releaseNo: 1, snapshot: r1 }, r2);
    expect(delta.kind).toBe('delta');
    if (delta.kind === 'delta') {
      expect(delta.title).toBeUndefined();
      expect(delta.intro).toBeUndefined();
    }

    // 序号 2 → 差量，但标题变了，应携带 title 差量
    const r2b: ChapterSnapshot = { ...r2, title: '新标题' };
    const delta2 = buildReleaseSnapshot(2, { releaseNo: 1, snapshot: r1 }, r2b);
    expect(delta2.kind).toBe('delta');
    if (delta2.kind === 'delta') {
      expect(delta2.title).toBe('新标题');
    }

    // 序号 4（4 % 3 === 1）→ 周期全量
    const full = buildReleaseSnapshot(4, { releaseNo: 3, snapshot: r2b }, r2b);
    expect(full.kind).toBe('full');
  });
});
