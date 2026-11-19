-- AlterTable
ALTER TABLE "Collection" ADD COLUMN "urlPattern" TEXT;

-- CreateTable
CREATE TABLE "Redirect" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "status" INTEGER NOT NULL DEFAULT 301,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Redirect_from_key" ON "Redirect"("from");
