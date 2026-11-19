-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Redirect" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "scope" TEXT NOT NULL DEFAULT '',
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "status" INTEGER NOT NULL DEFAULT 301,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Redirect" ("createdAt", "createdById", "from", "id", "status", "to", "updatedAt") SELECT "createdAt", "createdById", "from", "id", "status", "to", "updatedAt" FROM "Redirect";
DROP TABLE "Redirect";
ALTER TABLE "new_Redirect" RENAME TO "Redirect";
CREATE UNIQUE INDEX "Redirect_scope_from_key" ON "Redirect"("scope", "from");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
