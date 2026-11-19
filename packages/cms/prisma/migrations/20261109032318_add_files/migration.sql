-- CreateTable
CREATE TABLE "StoredFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storage" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "FileRef" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "fileId" TEXT NOT NULL,
    "sourceCollectionId" INTEGER NOT NULL,
    "sourceRecordId" INTEGER NOT NULL,
    "fieldId" INTEGER NOT NULL,
    "blockId" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "FileRef_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "StoredFile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "FileRef_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "Field" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "StoredFile_createdAt_idx" ON "StoredFile"("createdAt");

-- CreateIndex
CREATE INDEX "FileRef_fileId_idx" ON "FileRef"("fileId");

-- CreateIndex
CREATE INDEX "FileRef_sourceCollectionId_sourceRecordId_idx" ON "FileRef"("sourceCollectionId", "sourceRecordId");

-- CreateIndex
CREATE INDEX "FileRef_fieldId_sourceRecordId_idx" ON "FileRef"("fieldId", "sourceRecordId");
