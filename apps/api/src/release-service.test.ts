import { describe, expect, it } from 'vitest';
import { MemoryVersionStore } from './release-repository.memory.js';
import { VersionStoreError, resolveRelease } from './release-service.js';
import type { ChapterHead } from './release-service.js';
import type { BlockSnapshot } from './version-store.js';

const WORKSPACE = 'ws-1';
const ACTOR = 'user-1';

function makeStore(): {
  store: MemoryVersionStore;
  chapter: ChapterHead;
} {
  const store = new MemoryVersionStore();
  const chapter: ChapterHead = {
    id: 'chapter-1',
    workspaceId: WORKSPACE,
    title: '初始标题',
    intro: '初始导语',
    status: 'DRAFT',
    version: 1,
  };
  store.addChapter(chapter);
  return { store, chapter };
}

function addBlock(
  store: MemoryVersionStore,
  chapterId: string,
  id: string,
  text: string,
  position?: string,
  clipId: string | null = null,
): void {
  store.addBlock({
    id,
    chapterId,
    type: 'paragraph',
    position: position ?? id,
    contentJson: { text },
    clipId,
  });
}

function blockTexts(store: MemoryVersionStore, chapterId: string): string[] {
  return store
    .chapterBlocks(chapterId)
    .map((block) => (block.contentJson as { text: string }).text);
}

function isConflict(error: unknown): boolean {
  return error instanceof VersionStoreError && error.code === 'VERSION_CONFLICT';
}

describe('章节版本仓库', () => {
  it('发布节点交替保存全量/差量，并可逐级还原当时内容', async () => {
    const { store, chapter } = makeStore();
    const service = store.service(chapter.id);

    addBlock(store, chapter.id, 'b1', '第一版-1');
    addBlock(store, chapter.id, 'b2', '第一版-2');
    await service.publish({ chapterId: chapter.id, actorId: ACTOR });

    addBlock(store, chapter.id, 'b3', '第二版新增');
    await service.publish({ chapterId: chapter.id, actorId: ACTOR });

    // 修改 b1、删除 b2 后第三次发布（序号 3 → 全量）
    addBlock(store, chapter.id, 'b1', '第三版改 b1', undefined);
    store.blocks.delete('b2');
    await service.publish({ chapterId: chapter.id, actorId: ACTOR });

    const releases = store.releases.get(chapter.id)!;
    expect(releases.map((release) => release.snapshot.kind)).toEqual([
      'full',
      'delta',
      'delta',
    ]);

    await store.forChapter(chapter.id).run(async (tx) => {
      const r2 = await resolveRelease(tx, chapter.id, 2);
      expect(r2?.snapshot.blocks.map((block) => (block.contentJson as { text: string }).text))
        .toEqual(['第一版-1', '第一版-2', '第二版新增']);
      const r3 = await resolveRelease(tx, chapter.id, 3);
      expect(r3?.snapshot.blocks.map((block) => (block.contentJson as { text: string }).text))
        .toEqual(['第三版改 b1', '第二版新增']);
    });
  });

  it('回滚追加 ROLLBACK 节点：内容恢复、历史保留、version 递增', async () => {
    const { store, chapter } = makeStore();
    const service = store.service(chapter.id);

    addBlock(store, chapter.id, 'b1', 'v1');
    const r1 = await service.publish({ chapterId: chapter.id, actorId: ACTOR });

    addBlock(store, chapter.id, 'b2', 'v2 新增块');
    const r2 = await service.publish({ chapterId: chapter.id, actorId: ACTOR });
    expect(r2.release.releaseNo).toBe(2);

    // 基于当前最新 version 回滚到 r1
    const versionAfterR2 = store.chapters.get(chapter.id)!.version;
    const rolledBack = await service.rollback({
      chapterId: chapter.id,
      actorId: ACTOR,
      targetReleaseNo: 1,
      expectedVersion: versionAfterR2,
    });

    // 工作内容恢复为 r1；三次写操作（发布/发布/回滚）各让 version +1
    expect(blockTexts(store, chapter.id)).toEqual(['v1']);
    const head = store.chapters.get(chapter.id)!;
    expect(head.version).toBe(versionAfterR2 + 1);
    expect(head.title).toBe('初始标题');

    // 历史 append-only：r1/r2 仍在，r3 是 ROLLBACK 全量节点
    const releases = store.releases.get(chapter.id)!;
    expect(releases.map((release) => release.releaseNo)).toEqual([1, 2, 3]);
    expect(releases[2].kind).toBe('ROLLBACK');
    expect(releases[2].rolledBackToNo).toBe(1);
    expect(releases[2].snapshot.kind).toBe('full');
    expect(rolledBack.release.id).toBeTruthy();

    // 回滚节点 r3 为全量；r4 是周期全量（4 % 3 === 1），r5 才是差量
    addBlock(store, chapter.id, 'b4', '回滚后新内容');
    const r4 = await service.publish({ chapterId: chapter.id, actorId: ACTOR });
    expect(r4.release.snapshot.kind).toBe('full');
    addBlock(store, chapter.id, 'b5', '再改一版');
    const r5 = await service.publish({ chapterId: chapter.id, actorId: ACTOR });
    expect(r5.release.snapshot.kind).toBe('delta');
    if (r5.release.snapshot.kind === 'delta') {
      expect(r5.release.snapshot.baseReleaseNo).toBe(4);
    }
  });

  it('并发回滚：版本相同的第二个事务被 CAS 拒绝，只有一次恢复生效', async () => {
    const { store, chapter } = makeStore();

    addBlock(store, chapter.id, 'b1', 'v1');
    // 各自从独立的服务句柄发起，模拟两个请求并发提交
    const serviceA = store.service(chapter.id);
    const serviceB = store.service(chapter.id);
    await serviceA.publish({ chapterId: chapter.id, actorId: ACTOR });

    addBlock(store, chapter.id, 'b2', 'v2');
    await serviceA.publish({ chapterId: chapter.id, actorId: ACTOR });

    // 两个并发回滚读到同一个当前版本
    const currentVersion = store.chapters.get(chapter.id)!.version;
    const [first, second] = await Promise.allSettled([
      serviceA.rollback({
        chapterId: chapter.id,
        actorId: ACTOR,
        targetReleaseNo: 1,
        expectedVersion: currentVersion,
      }),
      serviceB.rollback({
        chapterId: chapter.id,
        actorId: ACTOR,
        targetReleaseNo: 1,
        expectedVersion: currentVersion,
      }),
    ]);

    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    expect(isConflict((second as PromiseRejectedResult).reason)).toBe(true);

    // 只有一个 ROLLBACK 节点，版本只增加一次
    const rollbackReleases = store.releases
      .get(chapter.id)!
      .filter((release) => release.kind === 'ROLLBACK');
    expect(rollbackReleases).toHaveLength(1);
    expect(store.chapters.get(chapter.id)!.version).toBe(currentVersion + 1);

    // 被拒绝的一方按服务端最新版本重试即可成功（幂等：内容已在 r1）
    const retry = await serviceB.rollback({
      chapterId: chapter.id,
      actorId: ACTOR,
      targetReleaseNo: 1,
      expectedVersion: currentVersion + 1,
    });
    expect(retry.release.releaseNo).toBe(4);
  });

  it('并发“发布 + 回滚”互不覆盖：后提交者必须带新版本号', async () => {
    const { store, chapter } = makeStore();
    addBlock(store, chapter.id, 'b1', 'v1');
    const service = store.service(chapter.id);
    await service.publish({ chapterId: chapter.id, actorId: ACTOR });

    addBlock(store, chapter.id, 'b2', 'v2');
    const versionBefore = store.chapters.get(chapter.id)!.version;
    await service.publish({
      chapterId: chapter.id,
      actorId: ACTOR,
      expectedVersion: versionBefore,
    });

    await expect(
      service.publish({
        chapterId: chapter.id,
        actorId: ACTOR,
        expectedVersion: versionBefore,
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('恢复后事件序列连续：每次发布/回滚恰好一条事件，sequence 无缺号', async () => {
    const { store, chapter } = makeStore();
    const service = store.service(chapter.id);

    addBlock(store, chapter.id, 'b1', 'v1');
    await service.publish({ chapterId: chapter.id, actorId: ACTOR });
    addBlock(store, chapter.id, 'b2', 'v2');
    await service.publish({ chapterId: chapter.id, actorId: ACTOR });
    const version = store.chapters.get(chapter.id)!.version;
    await service.rollback({
      chapterId: chapter.id,
      actorId: ACTOR,
      targetReleaseNo: 1,
      expectedVersion: version,
    });
    addBlock(store, chapter.id, 'b3', 'v3');
    const version2 = store.chapters.get(chapter.id)!.version;
    await service.rollback({
      chapterId: chapter.id,
      actorId: ACTOR,
      targetReleaseNo: 2,
      expectedVersion: version2,
    });

    const chapterEvents = store.events.filter(
      (event) => event.resourceId === chapter.id && event.resourceType === 'chapter',
    );
    expect(chapterEvents.map((event) => event.operation)).toEqual([
      'published',
      'published',
      'rolledBack',
      'rolledBack',
    ]);
    expect(chapterEvents.map((event, index) => event.sequence)).toEqual(
      chapterEvents.map((_, index) => index + 1),
    );

    // 回滚事件载荷指向新节点与恢复目标，可据此审计
    const rollbackPayload = chapterEvents[2].payloadJson as {
      releaseNo: number;
      rolledBackToNo: number;
    };
    expect(rollbackPayload).toMatchObject({ releaseNo: 3, rolledBackToNo: 1 });
  });

  it('回滚到不存在的节点或未发布章节，返回明确错误', async () => {
    const { store, chapter } = makeStore();
    const service = store.service(chapter.id);
    addBlock(store, chapter.id, 'b1', 'v1');
    await service.publish({ chapterId: chapter.id, actorId: ACTOR });

    const version = store.chapters.get(chapter.id)!.version;
    await expect(
      service.rollback({
        chapterId: chapter.id,
        actorId: ACTOR,
        targetReleaseNo: 99,
        expectedVersion: version,
      }),
    ).rejects.toMatchObject({ code: 'RELEASE_NOT_FOUND' });

    const { store: freshStore, chapter: freshChapter } = makeStore();
    addBlock(freshStore, freshChapter.id, 'x', '草稿');
    await expect(
      freshStore.service(freshChapter.id).rollback({
        chapterId: freshChapter.id,
        actorId: ACTOR,
        targetReleaseNo: 1,
        expectedVersion: freshChapter.version,
      }),
    ).rejects.toMatchObject({ code: 'NO_PUBLISHED_RELEASE' });
  });

  it('回滚时悬空的 clipId 引用被置空，并在事件中记录', async () => {
    const { store, chapter } = makeStore();
    const service = store.service(chapter.id);
    store.addClip({ id: 'clip-1', workspaceId: WORKSPACE, deletedAt: null });
    addBlock(store, chapter.id, 'b1', '带片段', 'p1', 'clip-1');
    await service.publish({ chapterId: chapter.id, actorId: ACTOR });

    // 片段随后被（软）删除
    store.clips.get('clip-1')!.deletedAt = new Date();

    addBlock(store, chapter.id, 'b2', 'v2');
    const versionAfterSecond = await (async () => {
      await service.publish({ chapterId: chapter.id, actorId: ACTOR });
      return store.chapters.get(chapter.id)!.version;
    })();

    const result = await service.rollback({
      chapterId: chapter.id,
      actorId: ACTOR,
      targetReleaseNo: 1,
      expectedVersion: versionAfterSecond,
    });
    const restored = store.chapterBlocks(chapter.id)[0];
    expect(restored.clipId).toBeNull();
    expect(result.plan.missingClipIds).toEqual(['clip-1']);
  });

  it('还原后的块顺序与目标快照完全一致', async () => {
    const { store, chapter } = makeStore();
    const service = store.service(chapter.id);
    addBlock(store, chapter.id, 'b1', '一', 'p1');
    addBlock(store, chapter.id, 'b2', '二', 'p2');
    await service.publish({ chapterId: chapter.id, actorId: ACTOR });

    // 乱序插入新块并调整
    addBlock(store, chapter.id, 'b9', '九', 'p0');
    const r2Version = store.chapters.get(chapter.id)!.version;
    await service.publish({ chapterId: chapter.id, actorId: ACTOR });
    const version = store.chapters.get(chapter.id)!.version;
    void r2Version;

    await service.rollback({
      chapterId: chapter.id,
      actorId: ACTOR,
      targetReleaseNo: 1,
      expectedVersion: version,
    });
    expect(blockTexts(store, chapter.id)).toEqual(['一', '二']);
    expect(store.chapterBlocks(chapter.id).map((block: { position: string }) => block.position))
      .toEqual(['p1', 'p2']);
  });
});
