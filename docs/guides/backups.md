# Back up and restore

A backup is one archive holding a consistent copy of the database and every uploaded file. `tansy backup` makes one, the server makes them on a schedule, and `tansy restore` puts one back. Archives go to any storage adapter, the same kind uploads use, so an S3-compatible bucket, a mounted disk, or a provider plugin all work.

## Set it up

Generate a key and keep a copy somewhere other than the backups, such as a password manager. Without it, no backup can be restored.

```sh
openssl rand -base64 32   # put it in TANSY_BACKUP_KEY
```

`tansy init` writes one into a new `.env`, and the Docker image generates one in `/data/secrets.env`. Then say where archives go in `tansy.config.ts`:

```ts
import { s3Storage } from "tansy/storage";

export default defineCms({
  // ...
  backups: {
    adapter: s3Storage({
      name: "backups",
      endpoint: process.env.BACKUP_S3_ENDPOINT!,
      bucket: process.env.BACKUP_S3_BUCKET!,
      accessKeyId: process.env.BACKUP_S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.BACKUP_S3_SECRET_ACCESS_KEY!,
      prefix: "backups",
    }),
    schedule: "0 3 * * *", // every day at 03:00 UTC
    keep: 14,              // the default is 7
  },
});
```

| Option | Default | Meaning |
|---|---|---|
| `adapter` | required | Any `StorageAdapter` with `list`. `localStorage({ dir })` and `s3Storage(...)` have it |
| `schedule` | none | Five cron fields in UTC. Without it, backups are made only by `tansy backup` |
| `keep` | 7 | Archives kept. Older ones are deleted after each successful backup |
| `files` | `true` | Copy uploads into each archive |
| `encrypt` | `true` | Encrypt with `TANSY_BACKUP_KEY`. The server refuses to start when the key is missing or shorter than 32 characters |

Send backups somewhere a failure of the server can't reach: another bucket, another account, ideally another provider. A backup in the same bucket as the uploads, or on the server's own disk, is lost with them. The starter's `tansy.config.ts` reads all of this from `TANSY_BACKUP_*` variables, listed in `.env.example`.

`tansy doctor` checks the configuration, the key, and on Postgres that the client tools are installed.

## Commands

```sh
tansy backup                       # to backups.adapter, then prune
tansy backup --out ./backups       # to a file or folder instead
tansy backup --no-files            # the database only
tansy backup list                  # archives in backups.adapter, newest first
tansy backup verify latest         # a file, a name from the list, or latest
tansy restore latest               # or a file, or a name from the list
```

In a clone of the repository, run them as `npm run tansy -- backup`. Run them from the app's folder, with the same environment as the server.

## What's in an archive

`cms-backup-<UTC time>-<random>.tar.gz`, or `.tar.gz.enc` when encrypted, holding:

| Entry | What |
|---|---|
| `database.sqlite` or `database.pgdump` | The database, copied by its own tools (below) |
| `files/<id>` | Each uploaded file the database copy knows about. Thumbnails are made again on request, so they're left out |
| `manifest.json` | The format version, tansy version, applied migrations, each entry's size and SHA-256, files storage couldn't supply, and fingerprints of the server's secrets |

The database is copied first, then the files it lists, so an archive never names a file it doesn't hold. A file uploaded after that moment isn't in it, and neither is its record. A file missing from storage is listed in the manifest and reported, rather than failing the backup.

An unencrypted archive is an ordinary `.tar.gz`. An encrypted one is AES-256-GCM in 64 KiB chunks, each authenticated with its position and whether it is the last, so a changed, reordered or cut-off archive fails to decrypt rather than restoring something partial. The key is derived from `TANSY_BACKUP_KEY` with HKDF and a random salt per archive.

## SQLite and Postgres

Each database is copied the way its own documentation recommends, which means very differently.

| | SQLite | Postgres |
|---|---|---|
| Copy | `VACUUM INTO`, one read transaction, in a worker thread so requests keep being served | `pg_dump --format=custom` of the `public` schema |
| Consistency | The read transaction | A snapshot exported by the CMS's own transaction, which also reads the file list, so dump and files match exactly |
| Check | `PRAGMA quick_check` on the copy | `pg_restore --list` on the dump |
| Restore | SQLite's backup API into the live file, so a leftover `-wal` file can never be replayed over it | `DROP SCHEMA public CASCADE`, then the dump, through `psql` in one transaction: a failure leaves the database as it was |
| Needs | Nothing beyond the CMS | `pg_dump`, `pg_restore` and `psql` of at least the server's major version. The Docker image includes them. `TANSY_PG_BIN` points at another folder |

The Postgres password is passed to the tools in their environment, never on the command line. A restore needs a role that may drop and create the `public` schema, normally the database's owner.

A backup restores onto the same kind of database. Moving from SQLite to Postgres is a different job.

## Restoring

1. Stop the server. A server left running would keep serving what it had in memory, and on SQLite could write over the restore. On Postgres, `tansy restore` refuses while other connections are open, unless `--force`.
2. Run `tansy restore latest`, or name a file or backup. It then:
   - decrypts and unpacks the archive into a temporary folder, and checks every checksum and the database copy;
   - refuses a backup of the other kind of database, or one made by a newer tansy, and nothing has changed yet;
   - refuses when `BETTER_AUTH_SECRET` or `TANSY_ENCRYPTION_KEY` differ from the ones the backup was made with, because stored two-factor, SMTP, OAuth and webhook secrets wouldn't decrypt. `--force` restores anyway;
   - asks you to type `restore`, unless `--yes`;
   - saves the current database as `cms-before-restore-….tar.gz` beside the SQLite file, or in the working folder for Postgres. `--safety-dir` chooses another folder, and `--no-safety-copy` skips it;
   - puts the files back first, so a storage failure leaves the site as it was. Files whose storage isn't configured any more go to the current upload adapter, and their records are pointed at it. `--no-files` skips this;
   - replaces the database, then applies migrations, so an older backup matches this version;
   - ends every session, and records `backup.restore` in the audit log.
3. Start the server.

Everything in the database is as it was when the backup was made, including accounts, passwords, roles and API keys. Review any that changed since: a key revoked after the backup works again until it is revoked again. Files uploaded since stay in storage, unreferenced.

## Watching it

Each scheduled run records `backup.create` in the audit log, with `success` or `failure`, and the job's last run is stored under `cms.backup`. A plugin's `onAudit` can forward failures to whatever alerts you. Backups made with `tansy backup` are audited too.

A backup nobody has tried to read is a hope. Run `tansy backup verify latest` regularly, on another machine if you can, and rehearse a full restore into a scratch database now and then.

## Docker

The image sets `TANSY_BACKUP_DIR=/data/backups` and generates `TANSY_BACKUP_KEY` once in `/data/secrets.env`. Copy that key off the volume. Backups to `/data/backups` sit on the same volume as the database, so copy them off too, or set `TANSY_BACKUP_S3_BUCKET`. Set `TANSY_BACKUP_SCHEDULE` to turn the schedule on.

```sh
docker compose exec tansy tansy-entrypoint /app/node_modules/.bin/tansy backup
docker compose stop cms
docker compose run --rm tansy /app/node_modules/.bin/tansy restore latest --yes --safety-dir /data
docker compose start cms
```

## Limits

- **A backup restores onto the same kind of database**, so it is not a way to move records from
  SQLite to Postgres or back. The schema travels as code; the records don't. Pick the database
  before you have content ([going to production](production.md)).
- A restore goes back to the moment of the backup. For less loss than the schedule's interval, add continuous archiving underneath: Litestream for SQLite, or point-in-time recovery from a Postgres provider.
- The server makes scheduled backups in its one process, and a run missed while it was stopped isn't made up.
- Making an archive needs free temporary space about the size of the database plus the largest file, and restoring about twice the archive's unpacked size. `TMPDIR` chooses where.
- Files are copied one by one through the server, four at a time, so a very large media library makes for long backups. Leaving them out with `files: false` and using the bucket's own versioning or replication is a fine alternative.
- There is no dashboard page for backups yet: a run's outcome is in the audit log and in the
  `cms.backup` job run.

See [Limits and boundaries](limits.md) for the rest of the CMS's own edges.
