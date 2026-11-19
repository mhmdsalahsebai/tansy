---
title: Run it with Docker
description: A container that needs no configuration, with data, uploads and generated secrets in one volume.
---

The image runs the CMS with SQLite and needs no configuration. Data, uploads and generated secrets
live in the `/data` volume.

```bash
docker build -t tansy .
docker run --name tansy -p 8090:8090 -v tansy-data:/data tansy
```

The server log prints a one-time setup link. Open it to create the superadmin, then sign in at
<http://localhost:8090>. If you publish a different port or a real domain, set `BETTER_AUTH_URL`
to that address with `-e`.

## With Postgres

For production with Postgres, set `POSTGRES_PASSWORD` and `BETTER_AUTH_URL`, then:

```bash
docker compose up -d
```

The setup link is in `docker compose logs tansy`.

## Before going live

- Set up [backups](/docs/guides/backups), and copy `TANSY_BACKUP_KEY` from `/data/secrets.env`
  somewhere safe. Without that key an archive cannot be restored.
- Point your load balancer's health check at `/api/ready`.
- Read [Running it](/docs/guides/operations) for what to watch and what the numbers mean.
