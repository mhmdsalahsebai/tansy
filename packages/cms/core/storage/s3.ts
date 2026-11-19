import { AwsClient } from "aws4fetch";
import type { ByteRange, ByteStream, PutOptions, SignedUrlOptions, StorageAdapter, StoredObject } from "./types";

export interface S3StorageOptions {
  /** Provider URL, such as https://s3.us-east-1.amazonaws.com or https://<account>.r2.cloudflarestorage.com. */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** "auto" suits Cloudflare R2. AWS and most others need the bucket's real region. */
  region?: string;
  /** Keeps several sites in one bucket. */
  prefix?: string;
  /** false uses https://<bucket>.<host>/ instead of https://<host>/<bucket>/. */
  pathStyle?: boolean;
  /** Needed only when two buckets are in use at once, such as during a move. */
  name?: string;
}

const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const xmlText = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
  if (name[0] !== "#") return XML_ENTITIES[name.toLowerCase()] ?? entity;
  return String.fromCodePoint(name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1)));
});
const xmlTag = (xml: string, tag: string) => {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? xmlText(match[1]) : null;
};

/**
 * Any service that speaks the S3 API: AWS, Cloudflare R2, Backblaze B2, MinIO,
 * DigitalOcean Spaces, Wasabi. Services that don't are a StorageAdapter plugin.
 */
export function s3Storage(options: S3StorageOptions): StorageAdapter {
  const { endpoint, bucket, accessKeyId, secretAccessKey, region = "auto", prefix = "", pathStyle = true, name = "s3" } = options;

  let client: AwsClient | undefined;
  // Built on first use, so a build without credentials in its environment still succeeds.
  const aws = () => (client ??= new AwsClient({ accessKeyId, secretAccessKey, region, service: "s3", retries: 0 }));

  const keyPrefix = prefix ? `${prefix.replace(/\/$/, "")}/` : "";

  const bucketUrl = () => {
    const url = new URL(endpoint);
    if (!pathStyle) url.hostname = `${bucket}.${url.hostname}`;
    url.pathname = `${url.pathname.replace(/\/$/, "")}${pathStyle ? `/${encodeURIComponent(bucket)}` : ""}/`;
    return url;
  };

  const objectUrl = (key: string) => {
    const url = bucketUrl();
    url.pathname = `${url.pathname}${encodeKey(keyPrefix + key)}`;
    return url;
  };

  /** Never includes the response body or signed URL, which can carry credentials into logs. */
  const failure = (action: string, response: Response) => new Error(`S3 ${action} failed with status ${response.status}.`);

  return {
    name,

    assertUsable() {
      const missing = Object.entries({ endpoint, bucket, accessKeyId, secretAccessKey }).filter(([, value]) => !value).map(([key]) => key);
      if (missing.length) throw new Error(`S3 storage is missing: ${missing.join(", ")}.`);
      new URL(endpoint);
    },

    async put(key: string, body: ByteStream, { size, contentType }: PutOptions) {
      const response = await aws().fetch(objectUrl(key), {
        method: "PUT",
        // S3 refuses chunked uploads, so the length has to be declared up front.
        headers: { "content-type": contentType, "content-length": String(size) },
        body,
        duplex: "half",
      } as RequestInit);
      await response.body?.cancel();
      if (!response.ok) throw failure("upload", response);
    },

    async get(key: string, range?: ByteRange) {
      const response = await aws().fetch(objectUrl(key), { headers: range ? { range: `bytes=${range.start}-${range.end}` } : {} });
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw failure("read", response);
      }
      return response.body as ByteStream;
    },

    async delete(key: string) {
      const response = await aws().fetch(objectUrl(key), { method: "DELETE" });
      await response.body?.cancel();
      if (!response.ok && response.status !== 404) throw failure("delete", response);
    },

    async list(listPrefix: string) {
      const found: StoredObject[] = [];
      let token: string | null = null;
      do {
        const url = bucketUrl();
        url.searchParams.set("list-type", "2");
        url.searchParams.set("prefix", keyPrefix + listPrefix);
        if (token) url.searchParams.set("continuation-token", token);
        const response = await aws().fetch(url);
        if (!response.ok) {
          await response.body?.cancel();
          throw failure("list", response);
        }
        const xml = await response.text();
        for (const [, entry] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = xmlTag(entry, "Key");
          if (key?.startsWith(keyPrefix)) found.push({ key: key.slice(keyPrefix.length), size: Number(xmlTag(entry, "Size") ?? 0) });
        }
        token = xmlTag(xml, "IsTruncated") === "true" ? xmlTag(xml, "NextContinuationToken") : null;
      } while (token);
      return found;
    },

    async signedUrl(key: string, { expiresIn, contentType, disposition }: SignedUrlOptions) {
      const url = objectUrl(key);
      url.searchParams.set("X-Amz-Expires", String(expiresIn));
      url.searchParams.set("response-content-type", contentType);
      url.searchParams.set("response-content-disposition", disposition);
      const signed = await aws().sign(url, { method: "GET", aws: { signQuery: true } });
      return signed.url;
    },
  };
}
