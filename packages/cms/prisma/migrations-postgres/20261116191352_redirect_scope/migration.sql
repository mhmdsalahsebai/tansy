-- DropIndex
DROP INDEX "Redirect_from_key";

-- AlterTable
ALTER TABLE "Redirect" ADD COLUMN     "scope" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE UNIQUE INDEX "Redirect_scope_from_key" ON "Redirect"("scope", "from");
