-- CreateTable
CREATE TABLE "FieldPreset" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FieldPreset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlockLayout" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "blocks" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlockLayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FieldValueState" (
    "type" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "upgradingTo" INTEGER,
    "cursorCollection" INTEGER NOT NULL DEFAULT 0,
    "cursorRecord" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "FieldValueState_pkey" PRIMARY KEY ("type")
);

-- CreateIndex
CREATE UNIQUE INDEX "FieldPreset_name_key" ON "FieldPreset"("name");

-- CreateIndex
CREATE UNIQUE INDEX "BlockLayout_name_key" ON "BlockLayout"("name");
