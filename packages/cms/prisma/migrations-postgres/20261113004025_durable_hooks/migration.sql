-- CreateTable
CREATE TABLE "HookDelivery" (
    "id" SERIAL NOT NULL,
    "source" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "collectionId" INTEGER NOT NULL,
    "recordId" INTEGER NOT NULL,
    "payload" TEXT NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "HookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HookDelivery_status_nextAttemptAt_idx" ON "HookDelivery"("status", "nextAttemptAt");
