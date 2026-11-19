-- AlterTable
ALTER TABLE "Collection" ADD COLUMN "localization" JSONB;

-- AlterTable
ALTER TABLE "UserProfile" ADD COLUMN "locale" TEXT;

-- CreateTable
CREATE TABLE "Locale" (
    "code" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "fallback" TEXT,
    "direction" TEXT NOT NULL DEFAULT 'ltr',
    "public" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_FileRef" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "fileId" TEXT NOT NULL,
    "sourceCollectionId" INTEGER NOT NULL,
    "sourceRecordId" INTEGER NOT NULL,
    "fieldId" INTEGER NOT NULL,
    "blockId" TEXT NOT NULL DEFAULT '',
    "locale" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "FileRef_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "StoredFile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "FileRef_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "Field" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_FileRef" ("blockId", "fieldId", "fileId", "id", "sourceCollectionId", "sourceRecordId") SELECT "blockId", "fieldId", "fileId", "id", "sourceCollectionId", "sourceRecordId" FROM "FileRef";
DROP TABLE "FileRef";
ALTER TABLE "new_FileRef" RENAME TO "FileRef";
CREATE INDEX "FileRef_fileId_idx" ON "FileRef"("fileId");
CREATE INDEX "FileRef_sourceCollectionId_sourceRecordId_idx" ON "FileRef"("sourceCollectionId", "sourceRecordId");
CREATE INDEX "FileRef_fieldId_sourceRecordId_idx" ON "FileRef"("fieldId", "sourceRecordId");
CREATE TABLE "new_RecordRef" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sourceCollectionId" INTEGER NOT NULL,
    "sourceRecordId" INTEGER NOT NULL,
    "fieldId" INTEGER NOT NULL,
    "blockId" TEXT NOT NULL,
    "targetCollectionId" INTEGER NOT NULL,
    "targetRecordId" INTEGER NOT NULL,
    "locale" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "RecordRef_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "Field" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RecordRef_targetCollectionId_fkey" FOREIGN KEY ("targetCollectionId") REFERENCES "Collection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_RecordRef" ("blockId", "fieldId", "id", "sourceCollectionId", "sourceRecordId", "targetCollectionId", "targetRecordId") SELECT "blockId", "fieldId", "id", "sourceCollectionId", "sourceRecordId", "targetCollectionId", "targetRecordId" FROM "RecordRef";
DROP TABLE "RecordRef";
ALTER TABLE "new_RecordRef" RENAME TO "RecordRef";
CREATE INDEX "RecordRef_sourceCollectionId_sourceRecordId_idx" ON "RecordRef"("sourceCollectionId", "sourceRecordId");
CREATE INDEX "RecordRef_fieldId_sourceRecordId_idx" ON "RecordRef"("fieldId", "sourceRecordId");
CREATE INDEX "RecordRef_targetCollectionId_targetRecordId_idx" ON "RecordRef"("targetCollectionId", "targetRecordId");
CREATE TABLE "new_Revision" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "collectionId" INTEGER NOT NULL,
    "recordId" INTEGER NOT NULL,
    "locale" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "values" JSONB NOT NULL,
    "createdById" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Revision_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Revision" ("collectionId", "createdAt", "createdById", "id", "kind", "note", "number", "recordId", "status", "values") SELECT "collectionId", "createdAt", "createdById", "id", "kind", "note", "number", "recordId", "status", "values" FROM "Revision";
DROP TABLE "Revision";
ALTER TABLE "new_Revision" RENAME TO "Revision";
CREATE INDEX "Revision_collectionId_recordId_locale_kind_number_idx" ON "Revision"("collectionId", "recordId", "locale", "kind", "number");
CREATE TABLE "new_ScheduledAction" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "collectionId" INTEGER NOT NULL,
    "recordId" INTEGER NOT NULL,
    "locale" TEXT NOT NULL DEFAULT '',
    "action" TEXT NOT NULL,
    "at" DATETIME NOT NULL,
    "createdById" TEXT,
    "failedAt" DATETIME,
    "error" TEXT,
    CONSTRAINT "ScheduledAction_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ScheduledAction" ("action", "at", "collectionId", "createdById", "error", "failedAt", "id", "recordId") SELECT "action", "at", "collectionId", "createdById", "error", "failedAt", "id", "recordId" FROM "ScheduledAction";
DROP TABLE "ScheduledAction";
ALTER TABLE "new_ScheduledAction" RENAME TO "ScheduledAction";
CREATE INDEX "ScheduledAction_at_idx" ON "ScheduledAction"("at");
CREATE UNIQUE INDEX "ScheduledAction_collectionId_recordId_locale_action_key" ON "ScheduledAction"("collectionId", "recordId", "locale", "action");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
