-- CreateTable
CREATE TABLE "HookDelivery" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "source" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "collectionId" INTEGER NOT NULL,
    "recordId" INTEGER NOT NULL,
    "payload" TEXT NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateIndex
CREATE INDEX "HookDelivery_status_nextAttemptAt_idx" ON "HookDelivery"("status", "nextAttemptAt");
