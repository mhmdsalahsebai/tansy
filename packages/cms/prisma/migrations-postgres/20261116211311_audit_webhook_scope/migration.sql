-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "scope" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Webhook" ADD COLUMN     "scope" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "AuditLog_scope_at_idx" ON "AuditLog"("scope", "at");
