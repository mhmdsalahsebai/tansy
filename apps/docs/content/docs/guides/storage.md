---
title: "File storage"
description: "Uploads go to a StorageAdapter, set under storage in tansy.config.ts. Core ships two: localStorage for development and s3Storage for anything that speaks the S3 API (AWS, Cloudflare R2, Backblaze B2, MinIO,…"
---

Uploads go to a `StorageAdapter`, set under `storage` in `tansy.config.ts`. Core ships two: `localStorage` for development and `s3Storage` for anything that speaks the S3 API (AWS, Cloudflare R2, Backblaze B2, MinIO, DigitalOcean Spaces, Wasabi). Other providers are plugins:

| Package | Provider | Thumbnails | Clients fetch from |
|---|---|---|---|
| `@tansy/storage-cloudinary` | Cloudinary | Made by Cloudinary, fetched by the CMS | The CMS |
| `@tansy/storage-bunny` | Bunny Storage | Made by Bunny Optimizer, with `cdn` set | The CMS, or Bunny's CDN for thumbnails |
| `@tansy/storage-vercel-blob` | Vercel Blob, private store | Made and stored by the CMS | The CMS |
| `@tansy/storage-uploadthing` | Uploadthing | Made and stored by the CMS | The CMS |
| `@tansy/storage-imgbb` | imgbb, images only, with a fallback for other files | Made and stored by the CMS | The CMS |

Every adapter but imgbb keeps files private at the provider. Whichever one you pick, a file is read only after the CMS's access checks (the security model, "Files").

## Set it up

Install the package and set it as the adapter. The starter picks one from the environment; see `apps/starter/.env.example`.

```ts
import { cloudinaryStorage } from "@tansy/storage-cloudinary";

export default defineCms({
  // ...
  storage: {
    adapter: cloudinaryStorage({
      cloudName: process.env.CLOUDINARY_CLOUD_NAME!,
      apiKey: process.env.CLOUDINARY_API_KEY!,
      apiSecret: process.env.CLOUDINARY_API_SECRET!,
    }),
  },
});
```

Each adapter takes `prefix`, a folder for every key so several sites can share one account, and `name`. The name is stored on each file, so keep it for as long as files live there. When moving to another provider, list the old adapter under `storage.previous`, so files already there stay readable, and give it its own `name` if both are the same kind.

A missing or malformed setting stops the server at startup, as `assertUsable` fails.

### Cloudinary

```ts
cloudinaryStorage({ cloudName, apiKey, apiSecret, signatureAlgorithm: "sha1" })
```

Files are stored as `authenticated` assets, which Cloudinary serves only with a signature. Raster images (PNG, JPEG, GIF, WebP, AVIF) are uploaded as images so Cloudinary can resize them. Anything else, including video, is stored untouched as `raw`. Set `signatureAlgorithm` to `"sha256"` if the account uses it (Settings, Security). Cloudinary caps each file's size by plan, so keep `maxUploadBytes` within it.

### Bunny

```ts
bunnyStorage({
  storageZone: "my-site",
  accessKey: process.env.BUNNY_STORAGE_PASSWORD!, // the zone's password, under FTP & API Access
  region: "de",                                   // the zone's main region
  cdn: { url: "https://my-site.b-cdn.net", tokenKey: process.env.BUNNY_TOKEN_KEY! },
})
```

`cdn` is optional. Without it, Bunny only stores bytes. With it, set up the pull zone first:

1. Connect a pull zone to the storage zone.
2. Turn on **Bunny Optimizer** for it.
3. Turn on **Token Authentication** (Security), and copy its key into `tokenKey`. Without token authentication anyone could read any file through the pull zone, so the adapter refuses a `cdn` without a key.
4. Add the pull zone's origin to `csp.img` in `tansy.config.ts`, so the dashboard can show its thumbnails.

### Vercel Blob

```ts
vercelBlobStorage({ token: process.env.BLOB_READ_WRITE_TOKEN! })
```

Create the store as **private**. Uploads are written private, so a public store refuses them. Vercel can sign URLs for private blobs, but can't set a download's file name or disposition, so the CMS streams every file itself, as Vercel recommends for private blobs.

### Uploadthing

```ts
uploadthingStorage({ token: process.env.UPLOADTHING_TOKEN! })
```

Files are uploaded with a private ACL, so either make the app private or allow overriding the ACL per file in its settings. Each file's custom id is the CMS's key for it, and reads go through a signed URL that the CMS fetches and never sends on.

### imgbb

```ts
imgbbStorage({ apiKey: process.env.IMGBB_API_KEY!, fallback: vercelBlobStorage({ token: process.env.BLOB_READ_WRITE_TOKEN! }) })
```

imgbb hosts images for free, which suits a public site's pictures, such as a shop's product photos. Take an API key from [api.imgbb.com](https://api.imgbb.com). Know what it can't do before choosing it:

- **Its images are public.** Anyone holding an image's address can open it. The CMS never hands the address out: it reads each image itself and serves it after its access checks, as with any other adapter. But nothing on imgbb can be made private, so don't keep pictures there that must stay private.
- **It keeps images only**, PNG, JPEG, GIF and WebP up to 32 MB, and only when it stores them unchanged. Everything else goes to `fallback`, any other adapter, and without one it's refused. A shop's digital editions, for example, go to the fallback.
- **It can't delete.** imgbb has no API for it, so a deleted file's image stays on imgbb, out of the CMS's reach, until removed by hand from the account.

imgbb picks each image's address, so the adapter keeps it in a storage index (below), in the database. A backup of the database holds the index; the images themselves stay on imgbb.

## Thumbnails

The dashboard and `/api/files/:id?thumb=` use four sizes: `100x100` and `300x300`, cropped, and `800x0` and `1600x0`, which keep the image's shape. `1600x0` is for images shown wide on high-density screens, as the second entry of a `srcset`. By default core makes each with `sharp` on first request and stores it beside the original.

An adapter with `thumbnailUrl` hands that to the provider's image service instead, and core neither renders nor stores thumbnails for it:

- When the provider's URLs expire (`thumbnailUrlsExpire`), as Bunny's signed URLs do, the CMS checks access and then redirects the browser to a URL valid for 5 minutes.
- When they don't, as Cloudinary's signed delivery URLs don't, the CMS fetches the thumbnail itself and passes it on, so no lasting URL reaches a browser. It passes on raster images only, up to 10 MB, and refuses anything else with `422 THUMBNAIL_FAILED`.

## Writing an adapter

Implement `StorageAdapter` from `tansy/storage`:

| Member | Required | Meaning |
|---|---|---|
| `name` | yes | Stored on each file |
| `put`, `get`, `delete` | yes | Move bytes. `get` honours a byte range and returns null for a missing key. `delete` succeeds when the key is already gone |
| `assertUsable` | no | Throw if the adapter must not run, for example on a missing setting |
| `list` | no | Every key under a prefix. Backups need it |
| `signedUrl` | no | Send browsers to the provider for originals. Only for providers that serve the given type and disposition, and whose URLs expire |
| `thumbnailUrl`, `thumbnailUrlsExpire` | no | Hand thumbnails to the provider, as above |

For a provider that picks its own address for each upload and can't be asked for it again, `storageIndex(name)` from `tansy/storage` keeps a small JSON value per key in the database, with `get`, `set`, `delete` and `list(prefix)`. Pass the adapter's own `name`, so two adapters never share an index. Check what you read back as you would a provider's answer.

`tansy/storage` also exports helpers the plugins use: `callProvider` makes a request that refuses redirects and fails with a `StorageProviderError` carrying only the status, since a provider's answer can quote keys or signatures. `rangeOf` cuts a full answer down to the requested range, for providers that ignore `Range`. `bodyBlob` reads an upload into memory for APIs that need a multipart form.
