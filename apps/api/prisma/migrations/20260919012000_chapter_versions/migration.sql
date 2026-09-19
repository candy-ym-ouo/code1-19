-- CreateEnum
CREATE TYPE "ChapterVersionKind" AS ENUM ('PUBLISH', 'ROLLBACK');

-- CreateTable
CREATE TABLE "ChapterVersion" (
    "id" TEXT NOT NULL,
    "chapterId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "kind" "ChapterVersionKind" NOT NULL DEFAULT 'PUBLISH',
    "title" TEXT NOT NULL,
    "intro" TEXT NOT NULL,
    "deltaJson" JSONB NOT NULL,
    "stateHash" TEXT NOT NULL,
    "parentStateHash" TEXT,
    "restoredFromRevision" INTEGER,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChapterVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChapterVersion_chapterId_revision_key" ON "ChapterVersion"("chapterId", "revision");

-- CreateIndex
CREATE INDEX "ChapterVersion_chapterId_revision_idx" ON "ChapterVersion"("chapterId", "revision");

-- CreateIndex
CREATE INDEX "ChapterVersion_workspaceId_createdAt_idx" ON "ChapterVersion"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "ChapterVersion" ADD CONSTRAINT "ChapterVersion_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "Chapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;
