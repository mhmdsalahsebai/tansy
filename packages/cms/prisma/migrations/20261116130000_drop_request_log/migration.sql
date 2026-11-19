-- The request log moved to the request-logs plugin, which keeps its entries in its own store.
-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "RequestLog";
PRAGMA foreign_keys=on;
