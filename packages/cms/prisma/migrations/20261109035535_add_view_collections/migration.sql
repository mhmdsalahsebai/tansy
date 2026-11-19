-- AlterTable
ALTER TABLE "Collection" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'base';
ALTER TABLE "Collection" ADD COLUMN "viewQuery" TEXT;
