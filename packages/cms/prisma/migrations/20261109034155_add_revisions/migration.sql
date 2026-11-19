-- CreateTable
CREATE TABLE "Revision" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "collectionId" INTEGER NOT NULL,
    "recordId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "values" JSONB NOT NULL,
    "createdById" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Revision_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScheduledAction" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "collectionId" INTEGER NOT NULL,
    "recordId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "at" DATETIME NOT NULL,
    "createdById" TEXT,
    "failedAt" DATETIME,
    "error" TEXT,
    CONSTRAINT "ScheduledAction_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Revision_collectionId_recordId_kind_number_idx" ON "Revision"("collectionId", "recordId", "kind", "number");

-- CreateIndex
CREATE INDEX "ScheduledAction_at_idx" ON "ScheduledAction"("at");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledAction_collectionId_recordId_action_key" ON "ScheduledAction"("collectionId", "recordId", "action");
