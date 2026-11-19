-- CreateTable
CREATE TABLE "TrashedRecord" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "scope" TEXT NOT NULL DEFAULT '',
    "collectionId" INTEGER NOT NULL,
    "recordId" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdById" TEXT,
    "deletedById" TEXT,
    "deletedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    CONSTRAINT "TrashedRecord_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TrashedFile" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "trashedId" INTEGER NOT NULL,
    "fileId" TEXT NOT NULL,
    CONSTRAINT "TrashedFile_trashedId_fkey" FOREIGN KEY ("trashedId") REFERENCES "TrashedRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TrashedFile_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "StoredFile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TrashedRecord_scope_deletedAt_idx" ON "TrashedRecord"("scope", "deletedAt");

-- CreateIndex
CREATE INDEX "TrashedRecord_createdById_idx" ON "TrashedRecord"("createdById");

-- CreateIndex
CREATE INDEX "TrashedRecord_expiresAt_idx" ON "TrashedRecord"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrashedRecord_collectionId_recordId_key" ON "TrashedRecord"("collectionId", "recordId");

-- CreateIndex
CREATE INDEX "TrashedFile_fileId_idx" ON "TrashedFile"("fileId");

-- CreateIndex
CREATE UNIQUE INDEX "TrashedFile_trashedId_fileId_key" ON "TrashedFile"("trashedId", "fileId");
