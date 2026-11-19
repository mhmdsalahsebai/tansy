-- CreateTable
CREATE TABLE "FieldPreset" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BlockLayout" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "blocks" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "FieldValueState" (
    "type" TEXT NOT NULL PRIMARY KEY,
    "version" INTEGER NOT NULL,
    "upgradingTo" INTEGER,
    "cursorCollection" INTEGER NOT NULL DEFAULT 0,
    "cursorRecord" INTEGER NOT NULL DEFAULT 0
);

-- CreateIndex
CREATE UNIQUE INDEX "FieldPreset_name_key" ON "FieldPreset"("name");

-- CreateIndex
CREATE UNIQUE INDEX "BlockLayout_name_key" ON "BlockLayout"("name");
