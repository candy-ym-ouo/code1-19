import { describe, expect, it } from 'vitest';
import { chapterRollbackSchema } from '../src/index.js';

describe('chapterRollbackSchema', () => {
  it('accepts a revision with an optional optimistic version', () => {
    const parsed = chapterRollbackSchema.parse({ revision: 3, expectedChapterVersion: 7 });
    expect(parsed.revision).toBe(3);
    expect(parsed.expectedChapterVersion).toBe(7);
  });

  it('accepts the expectedRevision alias', () => {
    const parsed = chapterRollbackSchema.parse({ revision: 1, expectedRevision: 2 });
    expect(parsed.expectedRevision).toBe(2);
  });

  it('requires an optimistic version to guard concurrent rollbacks', () => {
    expect(chapterRollbackSchema.safeParse({ revision: 1 }).success).toBe(false);
  });

  it('rejects revision zero or negative', () => {
    expect(chapterRollbackSchema.safeParse({ revision: 0 }).success).toBe(false);
    expect(chapterRollbackSchema.safeParse({ revision: -2 }).success).toBe(false);
  });

  it('rejects providing both version check aliases', () => {
    expect(
      chapterRollbackSchema.safeParse({
        revision: 1,
        expectedRevision: 2,
        expectedChapterVersion: 2,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(
      chapterRollbackSchema.safeParse({ revision: 1, force: true }).success,
    ).toBe(false);
  });
});
