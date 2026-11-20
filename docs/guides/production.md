# Going to production

A new install needs no decisions: `tansy init` writes a `.env` with fresh secrets, points the database
at a SQLite file beside the app, and keeps uploaded files on local disk. That is the whole setup, and
it is enough to build a site on.

Production is where those two defaults stop being free choices. This page is what to change, and
what each change costs.

## What the defaults are

| | Default | What it is good for |
| --- | --- | --- |
| Database | `DATABASE_URL="file:./dev.db"` — one SQLite file, created by `tansy migrate` | Development, and a single server whose disk is backed up |
| Files | Local disk, `data/uploads`, set up in `tansy.config.ts` by `tansy init` | Development, and a single server with a persistent volume |
| Secrets | `BETTER_AUTH_SECRET`, `TANSY_ENCRYPTION_KEY`, `TANSY_BACKUP_KEY` and `CRON_SECRET`, generated into `.env` | Everywhere. Keep copies away from the server |

Nothing about SQLite is a toy: the record layer, rules, search, revisions and backups all work on it,
and the integration suite runs on SQLite and Postgres alike. Its limits are operational rather than
functional — one process writes at a time, and the data lives on one machine's disk.

## Pick the database before you have content

**There is no supported way to move records from SQLite to Postgres, or back.** A backup restores
onto the same kind of database (see [backups](backups.md)), and while the *schema* travels as code —
export it from the dashboard, or point `TANSY_SCHEMA_FILE` at a file that is applied at startup — the
records do not. So choose before real content exists:

- **SQLite** if one server will serve the site for the foreseeable future, and its disk is backed
  up. Keep the file, and its `-wal` and `-shm` neighbours, out of any web root, readable only by the
  server's user.
- **Postgres** if you want a managed database, point-in-time recovery, or the freedom to replace the
  machine without moving a file. It is the choice that keeps every later option open.

Switching to Postgres before launch is two steps:

```bash
DATABASE_URL=postgres://user:password@host:5432/name
npx tansy migrate
```

`DATABASE_POOL_SIZE` (10 by default) caps the connections the record layer opens — set it below
whatever your provider or pgBouncer allows. The CMS still expects **one server process** on either
database: realtime, scheduled publishing, jobs and webhook queues all run in that process.

## Move files off the server's disk

Local disk refuses to start in production. That is deliberate: on most hosts the filesystem is
replaced on every deploy, and uploads would quietly disappear.

```bash
S3_BUCKET=my-bucket
S3_REGION=us-east-1
S3_ENDPOINT=https://s3.us-east-1.amazonaws.com
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
```

Any S3-compatible service works with those four — AWS, Cloudflare R2, Backblaze B2, MinIO — and
Cloudinary, Bunny, Vercel Blob and Uploadthing have plugins of their own. See
[storage](storage.md).

If you really do run one server with a backed-up volume, `ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true`
says so on purpose. Keep `UPLOADS_DIR` outside `public/`, or files would be served without a
permission check.

## The rest of the list

| Do this | Why |
| --- | --- |
| Set `BETTER_AUTH_URL` to the site's real address | Email links, OAuth redirects and cookie scope are built from it |
| Keep copies of `BETTER_AUTH_SECRET`, `TANSY_ENCRYPTION_KEY` and `TANSY_BACKUP_KEY` somewhere other than the server | A backup restores fully only with the secrets it was made under. Without `TANSY_ENCRYPTION_KEY` the settings key is derived from `BETTER_AUTH_SECRET`, so rotating that secret would make stored SMTP and OAuth secrets unreadable |
| Set up SMTP, or the email plugin | Password resets, invitations and alerts need a way out |
| Turn on **Require MFA for dashboard users** | The dashboard is the whole instance |
| Tell the CMS which header your proxy sets for the client IP | Rate limits and audit entries are only as honest as that header |
| Set up [backups](backups.md) and check one restores | An untested backup is a hope, not a plan |
| Point the health check at `/api/ready`, not `/api/health` | Readiness takes a starting or broken server out of rotation; liveness restarts a stuck one. See [running it](operations.md) |
| On Vercel, Netlify or Lambda, set `CRON_SECRET` and call `/api/background` | Nothing keeps timers running there. See [background work](background-work.md) |
| Decide `TANSY_SITE_CACHE_SECONDS` | How long a public read may lag a write. 0 turns the cache off |

## Handing out a login

A public demo, a workshop or a reviewer's trial needs an account whose email and password
everyone knows. List it in `TANSY_SHARED_ACCOUNTS`, separated by commas:

```bash
TANSY_SHARED_ACCOUNTS=demo@example.com
```

Anyone can sign in to a shared account and do whatever its role allows. Nobody signed in as it can
change the account itself: its password, email, name, user fields, two-factor, passkeys or linked
sign-ins, sign other people out of it, or delete it, and a password reset can't be requested for it.
Failed sign-ins never lock it, since the password is public anyway. Its interface language is kept
in each visitor's browser rather than on the account. A superadmin still manages it under **Users**.

Give it a role with only the permissions you mean to hand out. For a demo to look around in, that's
the read permissions: `dashboard:access`, `collection:read`, `record:list`, `record:read`,
`file:list`, `file:read`, `setting:read`, `redirect:read`, `webhook:read` and `role:list`. Leave out
`audit:read`, which shows other people's addresses and IPs, and anything with `user:`. **Require MFA
for dashboard users** would shut a shared account out, because nobody can set up its second factor.

## Docker

The image needs no configuration: `docker run -v tansy-data:/data` keeps the SQLite database,
uploads and generated secrets in the volume, and prints a one-time setup link. `docker compose up -d`
runs the same image against Postgres — set `POSTGRES_PASSWORD` and `BETTER_AUTH_URL`, and copy
`TANSY_BACKUP_KEY` out of `/data/secrets.env` before you need it.
