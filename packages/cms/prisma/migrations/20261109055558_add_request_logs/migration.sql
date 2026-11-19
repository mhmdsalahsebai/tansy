-- CreateTable
CREATE TABLE "RequestLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "actorId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT
);

-- CreateIndex
CREATE INDEX "RequestLog_at_idx" ON "RequestLog"("at");

-- CreateIndex
CREATE INDEX "RequestLog_status_at_idx" ON "RequestLog"("status", "at");
