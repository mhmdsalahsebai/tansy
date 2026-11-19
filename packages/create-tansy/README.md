# create-tansy

Creates a Next.js app with [tansy](https://www.npmjs.com/package/tansy).

```sh
npx create-tansy my-site
npx create-tansy my-blog --template blog
npx create-tansy my-front-end --template headless
```

| Template | What you get |
|---|---|
| `blank` (default) | The CMS and a site in one app, with an unstyled theme to build on |
| `blog` | The same, with a blog theme and its collections |
| `headless` | A front end only. It reads a tansy server over HTTP, set by `TANSY_URL` |

Options: `--database-url <url>` (SQLite in `dev.db` unless set) and `--no-install` (write the files and stop).
