-- AlterTable
ALTER TABLE "StoredFile" ADD COLUMN     "scope" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "StoredFile_scope_createdAt_idx" ON "StoredFile"("scope", "createdAt");
