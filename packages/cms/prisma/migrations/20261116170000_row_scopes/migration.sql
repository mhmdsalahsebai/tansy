-- AlterTable
ALTER TABLE "Collection" ADD COLUMN "scoped" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Role" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'instance';
