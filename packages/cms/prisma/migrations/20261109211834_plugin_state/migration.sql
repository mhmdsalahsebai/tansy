-- CreateTable
CREATE TABLE "PluginState" (
    "name" TEXT NOT NULL PRIMARY KEY,
    "version" TEXT NOT NULL,
    "applied" JSONB NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PluginData" (
    "plugin" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("plugin", "key")
);
