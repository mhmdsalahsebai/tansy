-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_StoredFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storage" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "temporary" BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO "new_StoredFile" ("createdAt", "createdById", "height", "id", "key", "name", "size", "storage", "type", "width") SELECT "createdAt", "createdById", "height", "id", "key", "name", "size", "storage", "type", "width" FROM "StoredFile";
DROP TABLE "StoredFile";
ALTER TABLE "new_StoredFile" RENAME TO "StoredFile";
CREATE INDEX "StoredFile_createdAt_idx" ON "StoredFile"("createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
