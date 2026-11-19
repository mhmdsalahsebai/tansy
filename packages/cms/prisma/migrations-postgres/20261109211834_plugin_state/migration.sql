-- CreateTable
CREATE TABLE "PluginState" (
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "applied" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PluginState_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "PluginData" (
    "plugin" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PluginData_pkey" PRIMARY KEY ("plugin","key")
);
