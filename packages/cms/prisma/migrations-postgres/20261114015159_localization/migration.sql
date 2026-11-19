-- DropIndex
DROP INDEX "Revision_collectionId_recordId_kind_number_idx";

-- DropIndex
DROP INDEX "ScheduledAction_collectionId_recordId_action_key";

-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "localization" JSONB;

-- AlterTable
ALTER TABLE "FileRef" ADD COLUMN     "locale" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "RecordRef" ADD COLUMN     "locale" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Revision" ADD COLUMN     "locale" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "ScheduledAction" ADD COLUMN     "locale" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "UserProfile" ADD COLUMN     "locale" TEXT;

-- CreateTable
CREATE TABLE "Locale" (
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "fallback" TEXT,
    "direction" TEXT NOT NULL DEFAULT 'ltr',
    "public" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Locale_pkey" PRIMARY KEY ("code")
);

-- CreateIndex
CREATE INDEX "Revision_collectionId_recordId_locale_kind_number_idx" ON "Revision"("collectionId", "recordId", "locale", "kind", "number");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledAction_collectionId_recordId_locale_action_key" ON "ScheduledAction"("collectionId", "recordId", "locale", "action");
