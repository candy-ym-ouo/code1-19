import { describe, expect, it } from 'vitest';
import {
  applyBlockDelta,
  applyChapterDelta,
  diffBlocks,
  diffChapter,
  isChapterDeltaEmpty,
  materialize,
  sameBlockContent,
  sortBlocks,
  stateHash,
  VersionIntegrityError,
  type ChapterDelta,
  type ChapterSnapshot,
  type StoredRevision,
  type VersionBlock,
} from './engine.js';

const block = (
  id: string,
  partial: Partial<VersionBlock> = {},
): VersionBlock => ({
  id,
  type: partial.type ?? 'paragraph',
  position: partial.position ?? id,
  contentJson: partial.contentJson ?? { text: id },
  clipId: partial.clipId ?? null,
});

describe('diffBlocks', () => {
  it('detects added, updated and removed blocks by id', () => {
    const prev = [block('a'), block('b'), block('c')];
    const next = [
      block('a'),
      block('b', { contentJson: { text: 'changed' } }),
      block('d'),
    ];

    const delta = diffBlocks(prev, next);

    expect(delta.removed).toEqual(['c']);
    expect(delta.updated.map((item) => item.id)).toEqual(['b']);
    expect(delta.added.map((item) => item.id)).toEqual(['d']);
  });

  it('treats reordered keys inside contentJson as equal', () => {
    const a = block('a', { contentJson: { x: 1, nested: { y: 2, z: 3 } } });
    const b = block('a', { contentJson: { nested: { z: 3, y: 2 }, x: 1 } });
    expect(sameBlockContent(a, b)).toBe(true);
    expect(diffBlocks([a], [b]).added).toHaveLength(0);
    expect(diffBlocks([a], [b]).updated).toHaveLength(0);
  });

  it('notices clipId, type and position changes', () => {
    const prev = [block('a', { type: 'paragraph', position: '01', clipId: null })];
    const next = [block('a', { type: 'quote', position: '02', clipId: 'clip-1' })];
    const delta = diffBlocks(prev, next);
    expect(delta.updated).toHaveLength(1);
  });

  it('returns an empty delta for identical states', () => {
    const blocks = [block('b'), block('a')];
    const delta = diffBlocks(blocks, [block('b'), block('a')]);
    expect(delta.added).toEqual([]);
    expect(delta.updated).toEqual([]);
    expect(delta.removed).toEqual([]);
  });
});

describe('applyBlockDelta', () => {
  it('round-trips a diff', () => {
    const prev = [block('a'), block('b'), block('c')];
    const next = [
      block('a'),
      block('b', { position: 'b2' }),
      block('d', { position: '0' }),
    ];
    const result = applyBlockDelta(prev, diffBlocks(prev, next));
    expect(sortBlocks(result)).toEqual(sortBlocks(next));
  });

  it('removes then re-adds the same id without resurrection', () => {
    const prev = [block('a'), block('b')];
    const applied = applyBlockDelta(prev, {
      added: [],
      updated: [],
      removed: ['a', 'b'],
    });
    expect(applied).toEqual([]);
  });
});

describe('stateHash', () => {
  it('is stable regardless of block order or JSON key order', () => {
    const snapshot: ChapterSnapshot = {
      title: '童年',
      intro: '',
      blocks: [block('a'), block('b', { contentJson: { x: 1, y: 2 } })],
    };
    const reordered: ChapterSnapshot = {
      title: '童年',
      intro: '',
      blocks: [block('b', { contentJson: { y: 2, x: 1 } }), block('a')],
    };
    expect(stateHash(snapshot)).toBe(stateHash(reordered));
  });

  it('changes when content changes', () => {
    const base: ChapterSnapshot = { title: 't', intro: '', blocks: [block('a')] };
    const changed: ChapterSnapshot = {
      title: 't',
      intro: '',
      blocks: [block('a', { contentJson: { text: 'other' } })],
    };
    expect(stateHash(base)).not.toBe(stateHash(changed));
  });
});

function publishRevision(
  revision: number,
  parent: StoredRevision | null,
  parentSnapshot: ChapterSnapshot | null,
  snapshot: ChapterSnapshot,
): StoredRevision {
  const base = parentSnapshot ?? { title: '', intro: '', blocks: [] };
  return {
    revision,
    deltaJson: diffChapter(base, snapshot),
    stateHash: stateHash(snapshot),
    parentStateHash: parent ? parent.stateHash : null,
  };
}

describe('materialize', () => {
  it('replays a chain of deltas to any revision', () => {
    const v1: ChapterSnapshot = { title: '标题1', intro: '引言', blocks: [block('a')] };
    const r1 = publishRevision(1, null, null, v1);
    const v2: ChapterSnapshot = {
      title: '标题2',
      intro: '引言',
      blocks: [block('a'), block('b')],
    };
    const r2 = publishRevision(2, r1, v1, v2);
    const v3: ChapterSnapshot = {
      title: '标题2',
      intro: '引言改了',
      blocks: [block('a', { contentJson: { text: 'a2' } })],
    };
    const r3 = publishRevision(3, r2, v2, v3);

    expect(materialize([r1, r2, r3], 1).snapshot).toEqual(v1);
    expect(materialize([r3, r1, r2], 2).snapshot).toEqual(v2);
    expect(materialize([r1, r2, r3]).snapshot).toEqual(v3);
  });

  it('models a publish -> edits -> rollback -> publish history', () => {
    // rev1 发布
    const published1: ChapterSnapshot = {
      title: '初版',
      intro: '',
      blocks: [block('b1'), block('b2')],
    };
    const r1 = publishRevision(1, null, null, published1);

    // rev2 发布（新增 b3、删除 b2）
    const published2: ChapterSnapshot = {
      title: '初版',
      intro: '',
      blocks: [block('b1'), block('b3')],
    };
    const r2 = publishRevision(2, r1, published1, published2);

    // rev3 回滚到 rev1（差量：published2 -> published1）
    const rollbackDelta: ChapterDelta = diffChapter(published2, published1);
    const r3: StoredRevision = {
      revision: 3,
      deltaJson: rollbackDelta,
      stateHash: stateHash(published1),
      parentStateHash: r2.stateHash,
    };

    const restored = materialize([r1, r2, r3], 3);
    expect(restored.snapshot).toEqual(published1);
    expect(restored.hash).toBe(stateHash(published1));

    // 回滚之后继续发布 rev4
    const published4: ChapterSnapshot = {
      title: '初版',
      intro: '新增引言',
      blocks: [block('b1'), block('b2'), block('b4')],
    };
    const r4 = publishRevision(4, r3, published1, published4);
    expect(materialize([r1, r2, r3, r4], 4).snapshot).toEqual(published4);
    expect(isChapterDeltaEmpty(r4.deltaJson)).toBe(false);
  });

  it('throws VersionIntegrityError when a stored state hash does not match replay', () => {
    const r1 = publishRevision(1, null, null, {
      title: 't',
      intro: '',
      blocks: [block('a')],
    });
    const tampered: StoredRevision = {
      ...r1,
      stateHash: 'deadbeef',
    };
    expect(() => materialize([tampered])).toThrow(VersionIntegrityError);
  });

  it('throws when the parent hash chain is broken', () => {
    const r1 = publishRevision(1, null, null, {
      title: 't',
      intro: '',
      blocks: [block('a')],
    });
    const r2: StoredRevision = {
      ...publishRevision(
        2,
        r1,
        { title: 't', intro: '', blocks: [block('a')] },
        { title: 't2', intro: '', blocks: [block('a')] },
      ),
      parentStateHash: 'wrong-parent',
    };
    expect(() => materialize([r1, r2], 2)).toThrow(/parentStateHash/);
  });

  it('re-applying a snapshot delta is idempotent when there are no changes', () => {
    const snapshot: ChapterSnapshot = { title: 't', intro: '', blocks: [block('a')] };
    const r = publishRevision(1, null, null, snapshot);
    const replay = applyChapterDelta(
      { title: '', intro: '', blocks: [] },
      r.deltaJson,
    );
    expect(replay).toEqual(snapshot);
  });
});
