-- AlterTable
ALTER TABLE "Collection" ADD COLUMN "reviewRequired" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ReviewRequest" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "collectionId" INTEGER NOT NULL,
    "recordId" INTEGER NOT NULL,
    "locale" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL,
    "submittedById" TEXT,
    "submittedAt" DATETIME NOT NULL,
    "note" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" DATETIME,
    "reviewNote" TEXT,
    CONSTRAINT "ReviewRequest_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ReviewRequest_state_submittedAt_idx" ON "ReviewRequest"("state", "submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewRequest_collectionId_recordId_locale_key" ON "ReviewRequest"("collectionId", "recordId", "locale");
