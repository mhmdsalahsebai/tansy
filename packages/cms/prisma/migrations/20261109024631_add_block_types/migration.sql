-- CreateTable
CREATE TABLE "BlockType" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "icon" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "fields" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "RecordRef" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sourceCollectionId" INTEGER NOT NULL,
    "sourceRecordId" INTEGER NOT NULL,
    "fieldId" INTEGER NOT NULL,
    "blockId" TEXT NOT NULL,
    "targetCollectionId" INTEGER NOT NULL,
    "targetRecordId" INTEGER NOT NULL,
    CONSTRAINT "RecordRef_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "Field" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RecordRef_targetCollectionId_fkey" FOREIGN KEY ("targetCollectionId") REFERENCES "Collection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "BlockType_name_key" ON "BlockType"("name");

-- CreateIndex
CREATE INDEX "RecordRef_sourceCollectionId_sourceRecordId_idx" ON "RecordRef"("sourceCollectionId", "sourceRecordId");

-- CreateIndex
CREATE INDEX "RecordRef_fieldId_sourceRecordId_idx" ON "RecordRef"("fieldId", "sourceRecordId");

-- CreateIndex
CREATE INDEX "RecordRef_targetCollectionId_targetRecordId_idx" ON "RecordRef"("targetCollectionId", "targetRecordId");
