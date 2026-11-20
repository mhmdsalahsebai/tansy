# create-tansy

Creates a Next.js app with [tansy](https://www.npmjs.com/package/tansy).

```sh
npm create tansy@latest
```

In a terminal it asks what you're making, which theme, where it will run, which database (SQLite,
Postgres, or Postgres in Docker), where uploads go, which features to add, and whether to create
your admin account now. Pressing Enter at every question gives a site with the blank theme on SQLite.

Every question has a flag. With `--yes`, or without a terminal, it asks nothing:

```sh
npm create tansy@latest my-site -- --yes
npm create tansy@latest my-shop -- --theme storefront --payments stripe --plugins email:resend,forms
npm create tansy@latest my-app -- --host serverless --database-url "$DATABASE_URL" --storage vercel-blob
npm create tansy@latest my-front -- --template headless --cms-url https://cms.example.com
```

| Flag | |
|---|---|
| `--template site\|headless` | A site with the CMS in it (default), or a front end that reads a tansy server over HTTP |
| `--theme <name>` | `blank`, `blog`, `magazine`, `dispatch`, `storefront` or `academy` |
| `--payments <provider>` | For the storefront theme: `stripe`, `polar`, `dodo`, `creem` or `commet` |
| `--host local\|server\|serverless` | Where it will run |
| `--database sqlite\|postgres\|docker` | `docker` writes `docker-compose.yml` and starts Postgres |
| `--database-url <url>` | A `postgres://` URL, or a `file:` URL for SQLite |
| `--storage local\|s3\|vercel-blob` | Where uploads go |
| `--plugins <list>` | `email`, `captcha`, `forms`, `analytics`, `social-sign-in`, `ai`, `pwned-passwords`, with a provider after a colon, as in `email:postmark` |
| `--admin-email <email>` | Create the superadmin. Without a terminal, the password comes from `TANSY_ADMIN_PASSWORD` |
| `--cms-url <url>` | The server a headless front end reads |
| `--git`, `--no-git` | Start a repository |
| `--no-install` | Write the files and stop |

`--template blank` and `--template blog` still work, as a site with that theme.
