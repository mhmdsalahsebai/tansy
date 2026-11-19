-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scope" TEXT NOT NULL DEFAULT '',
    "action" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "actorId" TEXT,
    "actorEmail" TEXT,
    "actorKind" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB
);
INSERT INTO "new_AuditLog" ("action", "actorEmail", "actorId", "actorKind", "at", "id", "ipAddress", "metadata", "outcome", "targetId", "targetType", "userAgent") SELECT "action", "actorEmail", "actorId", "actorKind", "at", "id", "ipAddress", "metadata", "outcome", "targetId", "targetType", "userAgent" FROM "AuditLog";
DROP TABLE "AuditLog";
ALTER TABLE "new_AuditLog" RENAME TO "AuditLog";
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");
CREATE INDEX "AuditLog_action_at_idx" ON "AuditLog"("action", "at");
CREATE INDEX "AuditLog_actorId_at_idx" ON "AuditLog"("actorId", "at");
CREATE INDEX "AuditLog_scope_at_idx" ON "AuditLog"("scope", "at");
CREATE TABLE "new_Webhook" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "scope" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" JSONB NOT NULL,
    "collections" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Webhook" ("collections", "createdAt", "createdById", "enabled", "events", "id", "name", "secret", "updatedAt", "url") SELECT "collections", "createdAt", "createdById", "enabled", "events", "id", "name", "secret", "updatedAt", "url" FROM "Webhook";
DROP TABLE "Webhook";
ALTER TABLE "new_Webhook" RENAME TO "Webhook";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
