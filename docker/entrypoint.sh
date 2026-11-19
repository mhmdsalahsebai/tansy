#!/bin/sh
# First boot needs no configuration: SQLite and uploads live in /data, and secrets
# are generated there once. Set DATABASE_URL and BETTER_AUTH_URL for production.
set -eu

secrets=/data/secrets.env
if [ ! -f "$secrets" ]; then
  umask 077
  {
    echo "GENERATED_AUTH_SECRET=$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"
    echo "GENERATED_ENCRYPTION_KEY=$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"
  } > "$secrets"
fi
# Added separately, so a volume made before backups existed gets one too.
if ! grep -q '^GENERATED_BACKUP_KEY=' "$secrets"; then
  echo "GENERATED_BACKUP_KEY=$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')" >> "$secrets"
fi
. "$secrets"

export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-$GENERATED_AUTH_SECRET}"
export TANSY_ENCRYPTION_KEY="${TANSY_ENCRYPTION_KEY:-$GENERATED_ENCRYPTION_KEY}"
# Backups made off this volume can't be restored without it: keep a copy elsewhere, or set your own.
export TANSY_BACKUP_KEY="${TANSY_BACKUP_KEY:-$GENERATED_BACKUP_KEY}"
export DATABASE_URL="${DATABASE_URL:-file:/data/cms.db}"
export BETTER_AUTH_URL="${BETTER_AUTH_URL:-http://localhost:${PORT}}"
export TANSY_HOOKS_DIR="${TANSY_HOOKS_DIR:-/data/cms_hooks}"

# `tansy backup` writes to the volume unless a bucket is configured. Copy them off it, or set TANSY_BACKUP_S3_BUCKET.
export TANSY_BACKUP_DIR="${TANSY_BACKUP_DIR:-/data/backups}"

# Uploads stay on the volume unless a bucket is configured.
if [ -z "${S3_BUCKET:-}" ]; then
  export UPLOADS_DIR="${UPLOADS_DIR:-/data/uploads}"
  export ALLOW_LOCAL_STORAGE_IN_PRODUCTION="${ALLOW_LOCAL_STORAGE_IN_PRODUCTION:-true}"
fi

/app/node_modules/.bin/prisma migrate deploy --config /app/packages/cms/prisma.config.ts
exec "$@"
