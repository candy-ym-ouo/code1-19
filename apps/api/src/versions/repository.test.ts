import { describe, expect, it } from 'vitest';
import {
  listChapterVersions,
  loadSnapshotAt,
  savePublishSnapshot,
  saveRollbackSnapshot,
  VersionConflictError,
} from './repository.js';
import type { ChapterDelta } from './engine.js';

type Row = {
  id: string;
  chapterId: string;
  workspaceId: string;
  revision: number;
  kind: 'PUBLISH' | 'ROLLBACK';
  title: string;
  intro: string;
  deltaJson: unknown;
  stateHash: string;
  parentStateHash: string | null;
  restoredFromRevision: number | null;
  createdById: string;
  createdAt: Date;
};

function createMemoryDb() {
  const rows: Row[] = [];
  let seq = 0;

  return {
    rows,
    chapterVersion: {
      async findFirst(args: {
        where: { chapterId: string };
        orderBy: { revision: 'desc' };
      }) {
        const matched = rows
          .filter((row) => row.chapterId === args.where.chapterId)
          .sort((a, b) => b.revision - a.revision);
        return matched[0] ?? null;
      },
      async findMany(args: {
        where: { chapterId: string; revision?: { lte?: number } };
        orderBy?: { revision: 'asc' | 'desc' };
      }) {
        let matched = rows.filter(
          (row) =>
            row.chapterId === args.where.chapterId &&
            (args.where.revision?.lte === undefined ||
              row.revision <= args.where.revision.lte),
        );
        matched = matched.sort((a, b) =>
          args.orderBy?.revision === 'desc'
            ? b.revision - a.revision
            : a.revision - b.revision,
        );
        return matched;
      },
      async create(args: { data: Omit<Row, 'id' | 'createdAt'> }) {
        const row: Row = {
          ...args.data,
          id: `version-${++seq}`,
          createdAt: new Date(0),
        };
        rows.push(row);
        return row;
      },
      async findFirstOrThrow(args: {
        where: { chapterId: string };
        orderBy: { revision: 'desc' };
      }) {
        const found = await this.findFirst(args);
        if (!found) throw new Error('not found');
        return found;
      },
    },
  };
}

const CHAPTER_ID = 'chapter-1';
const WORKSPACE_ID = 'workspace-1';
const USER_ID = 'user-1';

const blockRow = (id: string, text: string, position = id) => ({
  id,
  type: 'paragraph',
  position,
  contentJson: { text },
  clipId: null,
});

describe('chapter version repository', () => {
  it('saves delta snapshots across multiple publish nodes and replays them', async () => {
    const db = createMemoryDb();

    const v1 = await savePublishSnapshot({
      db: db as never,
      chapter: { id: CHAPTER_ID, workspaceId: WORKSPACE_ID, title: '标题1', intro: '' },
      blocks: [blockRow('a', '甲')],
      createdById: USER_ID,
    });

    const v2 = await savePublishSnapshot({
      db: db as never,
      chapter: { id: CHAPTER_ID, workspaceId: WORKSPACE_ID, title: '标题2', intro: '引言' },
      blocks: [blockRow('a', '甲'), blockRow('b', '乙')],
      createdById: USER_ID,
    });

    const v3 = await savePublishSnapshot({
      db: db as never,
      chapter: { id: CHAPTER_ID, workspaceId: WORKSPACE_ID, title: '标题2', intro: '引言' },
      blocks: [blockRow('a', '甲改')],
      createdById: USER_ID,
    });

    expect(v1.revision).toBe(1);
    expect(v2.revision).toBe(2);
    expect(v3.revision).toBe(3);
    expect(v2.parentStateHash).toBe(v1.stateHash);
    expect(v3.parentStateHash).toBe(v2.stateHash);

    // 每个节点都能通过差量链重放出当时的完整状态
    const at1 = await loadSnapshotAt(db as never, CHAPTER_ID, 1);
    const at2 = await loadSnapshotAt(db as never, CHAPTER_ID, 2);
    const at3 = await loadSnapshotAt(db as never, CHAPTER_ID, 3);

    expect(at1.snapshot).toEqual({
      title: '标题1',
      intro: '',
      blocks: [blockRow('a', '甲')],
    });
    expect(at2.snapshot.title).toBe('标题2');
    expect(at2.snapshot.blocks.map((block) => block.id)).toEqual(['a', 'b']);
    expect(at3.snapshot.blocks).toHaveLength(1);
    expect(at3.snapshot.blocks[0].contentJson).toEqual({ text: '甲改' });

    // 列表按 revision 倒序
    const list = await listChapterVersions(db as never, CHAPTER_ID);
    expect(list.map((item) => item.revision)).toEqual([3, 2, 1]);
    expect(list.every((item) => item.kind === 'PUBLISH')).toBe(true);
  });

  it('rejects publishing when nothing changed since the last version', async () => {
    const db = createMemoryDb();
    const args = {
      db: db as never,
      chapter: { id: CHAPTER_ID, workspaceId: WORKSPACE_ID, title: '标题', intro: '' },
      blocks: [blockRow('a', '甲')],
      createdById: USER_ID,
    };
    await savePublishSnapshot(args);
    await expect(savePublishSnapshot(args)).rejects.toMatchObject({
      code: 'NO_CHANGES_TO_PUBLISH',
    });
  });

  it('rolls back to an older node and appends a ROLLBACK node whose replay is continuous', async () => {
    const db = createMemoryDb();

    await savePublishSnapshot({
      db: db as never,
      chapter: { id: CHAPTER_ID, workspaceId: WORKSPACE_ID, title: '标题1', intro: '' },
      blocks: [blockRow('a', '甲'), blockRow('b', '乙')],
      createdById: USER_ID,
    });
    await savePublishSnapshot({
      db: db as never,
      chapter: { id: CHAPTER_ID, workspaceId: WORKSPACE_ID, title: '标题2', intro: '' },
      blocks: [blockRow('a', '甲改'), blockRow('c', '丙')],
      createdById: USER_ID,
    });

    // 当前线上状态（模拟发布之后又做了草稿编辑）
    const { snapshot: restored } = await loadSnapshotAt(db as never, CHAPTER_ID, 1);
    const rollback = await saveRollbackSnapshot({
      db: db as never,
      chapter: { id: CHAPTER_ID, workspaceId: WORKSPACE_ID },
      restored,
      current: {
        title: '草稿标题',
        intro: '草稿引言',
        blocks: [
          blockRow('a', '草稿内容'),
          blockRow('c', '丙'),
          blockRow('d', '丁'),
        ],
      },
      restoredFromRevision: 1,
      createdById: USER_ID,
    });

    expect(rollback.revision).toBe(3);
    expect(rollback.kind).toBe('ROLLBACK');
    expect(rollback.restoredFromRevision).toBe(1);

    // ROLLBACK 节点挂在最新发布节点（rev2）之后，形成连续哈希链
    const rev2 = db.rows.find((row) => row.revision === 2)!;
    expect(rollback.parentStateHash).toBe(rev2.stateHash);

    // 重放到 ROLLBACK 节点后，状态连续地等于 rev1
    const at3 = await loadSnapshotAt(db as never, CHAPTER_ID, 3);
    expect(at3.snapshot).toEqual(restored);
    expect(at3.stateHash).toBe(rollback.stateHash);

    // 回滚节点的差量记录了草稿 -> rev1 的变化
    const delta = db.rows.find((row) => row.revision === 3)!.deltaJson as ChapterDelta;
    expect(delta.blocks.removed).toEqual(['c', 'd']);
    expect(delta.blocks.added.map((block) => block.id)).toEqual(['b']);
    expect(delta.blocks.updated.map((block) => block.id)).toEqual(['a']);
    expect(delta.title).toEqual({ from: '草稿标题', to: '标题1' });
    expect(delta.intro).toEqual({ from: '草稿引言', to: '' });
  });

  it('reports VERSION_NOT_FOUND for a missing revision', async () => {
    const db = createMemoryDb();
    await expect(
      loadSnapshotAt(db as never, CHAPTER_ID, 42),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });
});
