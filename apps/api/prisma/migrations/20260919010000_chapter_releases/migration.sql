-- CreateEnum
CREATE TYPE "ChapterReleaseKind" AS ENUM ('PUBLISH', 'ROLLBACK');

-- CreateTable
CREATE TABLE "ChapterRelease" (
    "id" TEXT NOT NULL,
    "chapterId" TEXT NOT NULL,
    "releaseNo" INTEGER NOT NULL,
    "kind" "ChapterReleaseKind" NOT NULL,
    "rolledBackToNo" INTEGER,
    "snapshotKind" TEXT NOT NULL,
    "baseReleaseNo" INTEGER,
    "snapshotJson" JSONB NOT NULL,
    "actorId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChapterRelease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChapterRelease_chapterId_releaseNo_key" ON "ChapterRelease"("chapterId", "releaseNo");

-- CreateIndex
CREATE INDEX "ChapterRelease_chapterId_createdAt_idx" ON "ChapterRelease"("chapterId", "createdAt");

-- AddForeignKey
ALTER TABLE "ChapterRelease" ADD CONSTRAINT "ChapterRelease_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "Chapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;
