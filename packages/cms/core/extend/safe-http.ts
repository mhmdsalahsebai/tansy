import "server-only";
import { lookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]] as const) blocked.addSubnet(network, prefix, "ipv6");

/** Private, loopback, link-local (cloud metadata) and other addresses a webhook must not reach. */
export function isBlockedAddress(address: string) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  const target = mapped ?? address;
  const family = isIP(target);
  if (!family) return true;
  return blocked.check(target, family === 4 ? "ipv4" : "ipv6");
}

export const allowPrivateWebhooks = () => process.env.TANSY_WEBHOOK_ALLOW_PRIVATE === "true";

/** Checked when a webhook is saved and again on every delivery. */
export function webhookUrlProblem(raw: string, allowPrivate = allowPrivateWebhooks()): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return "Enter a valid URL."; }
  if (url.username || url.password) return "The URL can't contain credentials.";
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) return "The URL must use https.";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!allowPrivate && (isIP(host) ? isBlockedAddress(host) : /(^|\.)(localhost|local|internal)$/i.test(host))) return "The URL can't point at a private address.";
  return null;
}

type LookupOptions = { all?: boolean; family?: number | string };
type LookupDone = (error: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void;

/** Checks the address actually connected to, so a name can't resolve publicly when saved and privately when sent. */
export function guardedLookup(hostname: string, options: LookupOptions, done: LookupDone) {
  lookup(hostname, { all: true, family: options.family as 0 | 4 | 6 | undefined }, (error, addresses) => {
    if (error) return done(error);
    if (addresses.some(({ address }) => isBlockedAddress(address))) return done(Object.assign(new Error("The host resolves to a private address."), { code: "EBLOCKED" }));
    if (options.all) return done(null, addresses);
    done(null, addresses[0].address, addresses[0].family);
  });
}

/** POSTs without following redirects, since a redirect could lead to a private address. Resolves with the status code. */
export function postJson(rawUrl: string, body: string, headers: Record<string, string>, timeoutMs = 10_000) {
  const allowPrivate = allowPrivateWebhooks();
  const problem = webhookUrlProblem(rawUrl, allowPrivate);
  if (problem) return Promise.reject(new Error(problem));
  const url = new URL(rawUrl);
  const request = url.protocol === "https:" ? https.request : http.request;
  return new Promise<number>((resolve, reject) => {
    const outgoing = request(url, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers },
      signal: AbortSignal.timeout(timeoutMs),
      ...(allowPrivate ? {} : { lookup: guardedLookup as never }),
    }, (response) => {
      resolve(response.statusCode ?? 0);
      response.destroy();
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}
