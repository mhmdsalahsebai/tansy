/**
 * Typed client for the tansy API. No dependencies, and works in browsers,
 * Node and edge runtimes. Generate types for your instance with `npm run tansy -- types`:
 *
 *   const cms = createClient<CmsCollections>({ url: "https://cms.example.com", apiKey });
 *   const posts = await cms.collection("posts").list({ filter: 'status = "published"' });
 *
 * A browser on another origin needs that origin under Settings → Network → Trusted origins.
 * Members sign in with `cms.auth`, which keeps their session token when Bearer tokens are on.
 */
import type { PreviewedRecord, SiteLocalization, SiteReader } from "../core/site/page";
import type { SiteList, SiteRecord } from "../core/theme/define";

export class CmsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = "CmsError";
  }
}

/**
 * The language to read or write, for collections with localization on. Others ignore it.
 * `"*"` reads every language, each localized field as `{ en: …, fr: … }`. `fallback: "none"`
 * reads only that language, so a record with no translation in it isn't there.
 */
export interface LocaleOptions {
  locale?: string;
  fallback?: "chain" | "none";
}

export interface ListOptions extends LocaleOptions {
  page?: number;
  perPage?: number;
  sort?: string;
  filter?: string;
  expand?: string;
  fields?: string;
  skipTotal?: boolean;
  search?: string;
}

export interface ViewOptions extends LocaleOptions { expand?: string; fields?: string }

/** Every language of a field, by language code, as `locale: "*"` returns it. */
export type Localized<T> = Record<string, T>;

export interface Page<T> {
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  items: T[];
}

export interface ClientOptions {
  /** Where the CMS API is served, if routes.api was changed. */
  apiPath?: string;
  /** Base URL of the CMS. Empty for the same origin in a browser. */
  url?: string;
  apiKey?: string;
  /**
   * A member's session token, sent as `Authorization: Bearer`. Sign-in through `auth` sets it,
   * or pass one you kept, such as from your site's own HttpOnly cookie. Needs Settings → Sign-in
   * methods → Bearer tokens.
   */
  token?: string;
  /** Called whenever `auth` gets a new session token, or null when it ends, so you can keep it. */
  onToken?: (token: string | null) => void;
  /**
   * Whether a browser sends the CMS's cookies. "include" lets a site on a sibling subdomain use
   * the cookie session, without bearer tokens. Ignored outside browsers.
   */
  credentials?: RequestCredentials;
  fetch?: typeof fetch;
  /** The language every call reads and writes unless it names its own. See `withLocale`. */
  locale?: string;
}

/** Who a request reads as. "visitor" sends no session, so the answer can be cached for everyone. "member" reads as the signed-in person under API rules alone. */
type ReadAs = "caller" | "visitor" | "member";

/** What better-auth answers with a session: the user and the session's details. */
export interface AuthSession {
  user: { id: string; email: string; name: string; emailVerified: boolean; image?: string | null; [field: string]: unknown };
  session: { id: string; expiresAt: string; [field: string]: unknown };
}

/** better-auth's answer to an email sign-in. With two-factor on, only `twoFactorRedirect`, and the code goes to `/two-factor/verify-totp` through `auth.call`. */
export type SignInResult = { token: string | null; user: AuthSession["user"]; redirect?: boolean; url?: string } | { twoFactorRedirect: true };

/** How a headless site's framework may cache the reads `reader()` makes. Previews are never cached. */
export interface ReaderOptions {
  /** Next.js cache tags for every read, such as ["cms"], which the revalidation route from tansy/headless clears. */
  tags?: string[];
  /** Seconds a read may be served from the cache, or false to keep it until a tag is cleared. Without it, reads aren't cached. */
  revalidate?: number | false;
}

/** Where a record has the same address in each language it's published in, by language code. */
export type Alternates = Record<string, string>;
export type ResolveResult<T> =
  | { type: "record"; collection: string; path: string; record: T; locale?: string; alternates?: Alternates }
  | { type: "redirect"; to: string; status: number };

export type RealtimeEvent<T> = { action: "create" | "update" | "delete"; record: T };
export type WriteValues<T> = Partial<Omit<T, "id" | "status" | "createdAt" | "updatedAt" | "publishedAt" | "createdById">> & { status?: "draft" | "published" };
export type BatchRequest = { method: "POST" | "PATCH" | "DELETE"; url: string; body?: Record<string, unknown> };

const queryString = (options: object) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) if (value !== undefined) params.set(key, String(value));
  const text = params.toString();
  return text ? `?${text}` : "";
};

export class CmsClient<C extends object = Record<string, Record<string, unknown>>> {
  private readonly base: string;
  private readonly api: string;
  private readonly apiKey?: string;
  private readonly fetcher: typeof fetch;
  private readonly credentials?: RequestCredentials;
  private readonly onToken?: (token: string | null) => void;
  private sessionToken: string | null;
  private readonly options: ClientOptions;
  /** The language calls use when they don't name one. */
  readonly locale?: string;

  constructor(options: ClientOptions = {}) {
    this.options = options;
    this.locale = options.locale || undefined;
    this.base = (options.url ?? "").replace(/\/$/, "");
    this.api = (options.apiPath ?? "/api").replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.sessionToken = options.token || null;
    this.onToken = options.onToken;
    this.credentials = options.credentials;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * The same client reading and writing `locale`, such as `client.withLocale("fr")`.
   * It starts with this client's current session token, and keeps its own from then on.
   */
  withLocale(locale: string) {
    return new CmsClient<C>({ ...this.options, token: this.sessionToken ?? undefined, locale });
  }

  /** Adds this client's language to a call's options, unless the call names one. */
  private localized<T extends object>(options: T): T & LocaleOptions {
    return this.locale && !("locale" in options && (options as LocaleOptions).locale) ? { ...options, locale: this.locale } : options;
  }

  /** The member's current session token, or null. */
  get token() {
    return this.sessionToken;
  }

  /** Uses another session token from now on, or none. */
  setToken(token: string | null) {
    this.sessionToken = token || null;
  }

  private headers(extra: Record<string, string> = {}, as: ReadAs = "caller"): Record<string, string> {
    const headers: Record<string, string> = {};
    // A member is a signed-in person, so an API key never goes with a member's read: the CMS refuses the pair.
    if (this.apiKey && as !== "member") headers["x-api-key"] = this.apiKey;
    if (this.sessionToken && as !== "visitor") headers.authorization = `Bearer ${this.sessionToken}`;
    if (as === "member") headers["x-cms-as"] = "member";
    return { ...headers, ...extra };
  }

  private credentialsFor(as: ReadAs): { credentials?: RequestCredentials } {
    // A visitor's read must not carry a cookie session, or a shared cache could keep one person's answer.
    if (as === "visitor") return this.credentials === "include" ? { credentials: "same-origin" } : {};
    return this.credentials ? { credentials: this.credentials } : {};
  }

  private async send(path: string, init: { method?: string; body?: unknown; cache?: ReaderOptions; as?: ReadAs }) {
    const as = init.as ?? "caller";
    const caching = init.cache && (init.cache.tags?.length || init.cache.revalidate !== undefined) ? { next: { tags: init.cache.tags, revalidate: init.cache.revalidate } } : {};
    return this.fetcher(this.base + path, {
      method: init.method ?? "GET",
      headers: this.headers(init.body === undefined ? {} : { "content-type": "application/json" }, as),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      ...this.credentialsFor(as),
      // Read by Next.js's fetch and ignored by any other.
      ...caching,
    });
  }

  /** Any JSON endpoint on the CMS, including extension routes under /api/ext. */
  async request<T = unknown>(path: string, init: { method?: string; body?: unknown; cache?: ReaderOptions; as?: ReadAs } = {}): Promise<T> {
    const response = await this.send(path, init);
    if (response.status === 204) return undefined as T;
    const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string; details?: unknown } } | null;
    if (!response.ok) throw new CmsError(response.status, body?.error?.code ?? "REQUEST_FAILED", body?.error?.message ?? `Request failed with ${response.status}.`, body?.error?.details);
    return body as T;
  }

  /**
   * Sign-in and the rest of the member's account, through better-auth at /api/auth. Any
   * endpoint works with `call`, such as `/two-factor/verify-totp` or `/sign-in/magic-link`.
   * Whenever an answer carries a new session token, the client keeps it and calls `onToken`.
   */
  get auth() {
    const call = async <T = unknown>(path: string, body?: Record<string, unknown>, method?: "GET" | "POST"): Promise<T> => {
      const response = await this.send(`${this.api}/auth${path.startsWith("/") ? path : `/${path}`}`, { method: method ?? (body === undefined ? "GET" : "POST"), body });
      const token = response.headers.get("set-auth-token");
      if (token && token !== this.sessionToken) {
        this.sessionToken = token;
        this.onToken?.(token);
      }
      const data = await response.json().catch(() => null) as ({ code?: string; message?: string; error?: { code?: string; message?: string } } & Record<string, unknown>) | null;
      if (!response.ok) {
        // better-auth answers { code, message }, the CMS's own routes { error: { code, message } }.
        const error = data?.error ?? data;
        throw new CmsError(response.status, error?.code ?? "AUTH_ERROR", error?.message ?? `Request failed with ${response.status}.`);
      }
      return data as T;
    };
    return {
      call,
      signIn: {
        email: (input: { email: string; password: string; rememberMe?: boolean; callbackURL?: string }) => call<SignInResult>("/sign-in/email", input),
      },
      signUp: {
        /** Custom user fields a member may set go alongside, by name. */
        email: (input: { name: string; email: string; password: string; callbackURL?: string; [field: string]: unknown }) => call<{ token: string | null; user: AuthSession["user"] }>("/sign-up/email", input),
      },
      /** The signed-in member, or null. */
      session: () => call<AuthSession | null>("/get-session"),
      signOut: async () => {
        try {
          await call("/sign-out", {});
        } finally {
          const had = this.sessionToken !== null;
          this.sessionToken = null;
          if (had) this.onToken?.(null);
        }
      },
      /** Sends the reset email. `redirectTo` is the page on your site that takes `?token=`, and must be on a trusted origin. */
      requestPasswordReset: (input: { email: string; redirectTo: string }) => call<{ status: boolean }>("/request-password-reset", input),
      resetPassword: (input: { token: string; newPassword: string }) => call<{ status: boolean }>("/reset-password", input),
    };
  }

  /** What a site address shows: a record the caller may view, or a redirect. Throws a 404 CmsError for anything else, including records the caller can't see. */
  resolve<T = Record<string, unknown>>(path: string, options: ViewOptions = {}) {
    return this.request<ResolveResult<T>>(`${this.api}/resolve${queryString({ ...this.localized(options), path })}`);
  }

  /** The languages a site publishes, with the default first. */
  locales() {
    return this.request<{ defaultLocale: string; items: Array<{ code: string; label: string; direction: "ltr" | "rtl"; fallback: string | null }> }>(`${this.api}/locales`);
  }

  collection<K extends keyof C & string>(slug: K) {
    type Row = C[K];
    const base = `${this.api}/collections/${encodeURIComponent(slug)}/records`;
    return {
      list: (options: ListOptions = {}) => this.request<Page<Row>>(base + queryString(this.localized(options))),
      get: (id: number, options: ViewOptions = {}) => this.request<Row>(`${base}/${id}${queryString(this.localized(options))}`),
      /** `locale` is the language the localized values go to. Shared values are the same in every language. */
      create: (values: WriteValues<Row>, options: { locale?: string } = {}) => this.request<Row>(base + queryString(this.localized(options)), { method: "POST", body: values }),
      update: (id: number, values: WriteValues<Row>, options: { locale?: string } = {}) => this.request<Row>(`${base}/${id}${queryString(this.localized(options))}`, { method: "PATCH", body: values }),
      delete: (id: number) => this.request<void>(`${base}/${id}`, { method: "DELETE" }),
      /** Removes one language's translation. The record and its other languages stay. */
      deleteTranslation: (id: number, locale: string) => this.request<void>(`${this.api}/collections/${encodeURIComponent(slug)}/content/${id}/translations/${encodeURIComponent(locale)}`, { method: "DELETE" }),
      /**
       * Calls back for each change you are allowed to see. Pass an id for one record.
       * With a language, changes arrive as that language reads them. Returns a function that stops it.
       */
      subscribe: (callback: (event: RealtimeEvent<Row>) => void, id?: number, options: LocaleOptions = {}) => {
        const query = this.localized(options);
        const extra = query.locale ? `?options=${encodeURIComponent(JSON.stringify({ query: Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined)) }))}` : "";
        return this.subscribe(`${slug}/${id ?? "*"}${extra}`, callback);
      },
    };
  }

  /** A record's unpublished state, from a token the dashboard issued. Null once the token is invalid or has expired. */
  preview(token: string) {
    return this.orNull(this.request<PreviewedRecord>(`${this.api}/preview${queryString({ token })}`));
  }

  /**
   * The reads `loadSitePage` from tansy/react makes, so a theme renders here as it does in the same app.
   * Pass `cache` to let Next.js cache them, cleared by a webhook through tansy/headless.
   * Only use it with no API key, or one that reads as a visitor, as cached reads are shared by every visitor.
   *
   * They read as a visitor even when the client holds a member's token, so they're safe to cache.
   * `viewer()` reads as that member, under API rules alone and never cached, so members' pages
   * render as they do in the same app.
   */
  reader(cache: ReaderOptions = {}): SiteReader {
    return { ...this.readsAs("visitor", cache), viewer: async () => (this.sessionToken || this.credentials === "include" ? this.readsAs("member", {}) : null) };
  }

  private readsAs(as: ReadAs, cache: ReaderOptions): SiteReader {
    const slug = (name: string) => `${this.api}/collections/${encodeURIComponent(name)}/records`;
    const read = <T>(path: string) => this.request<T>(path, { cache, as });
    const list = async (name: string, options: Record<string, unknown> = {}) => {
      try {
        return await read<SiteList>(slug(name) + queryString(this.localized(options)));
      } catch (error) {
        if (error instanceof CmsError && (error.status === 403 || error.status === 404)) return { page: 1, perPage: 0, totalItems: 0, totalPages: 0, items: [] };
        throw error;
      }
    };
    return {
      resolve: (path, options = {}) => this.orNull(read<ResolveResult<SiteRecord>>(`${this.api}/resolve${queryString({ ...this.localized(options), path })}`)),
      list,
      get: (name, id, options = {}) => this.orNull(read<SiteRecord>(`${slug(name)}/${id}${queryString(this.localized(options))}`)),
      singleton: async (name, options = {}) => (await list(name, { ...options, perPage: 1 })).items[0] ?? null,
      localization: () => read<SiteLocalization>(`${this.api}/locales`),
      branding: async () => {
        const { appName, logoUrl, accentColor } = await read<{ appName: string; logoUrl: string; accentColor?: string }>(`${this.api}/auth-config`);
        return { name: appName, logoUrl, accentColor };
      },
      preview: (token) => this.preview(token),
      fileUrl: (id, thumb) => this.fileUrl(id, thumb),
    };
  }

  private async orNull<T>(read: Promise<T>): Promise<T | null> {
    try {
      return await read;
    } catch (error) {
      if (error instanceof CmsError && error.status === 404) return null;
      throw error;
    }
  }

  batch(requests: BatchRequest[]) {
    return this.request<Array<{ status: number; body?: unknown }>>(`${this.api}/batch`, { method: "POST", body: { requests } });
  }

  /** The URL of a file. Add a size for a thumbnail. */
  fileUrl(id: string, thumb?: "100x100" | "300x300" | "800x0" | "1600x0") {
    return `${this.base}${this.api}/files/${encodeURIComponent(id)}${thumb ? `?thumb=${thumb}` : ""}`;
  }

  /** Reads the stream with fetch, since the browser's EventSource can't send an API key. */
  private subscribe<T>(topic: string, callback: (event: RealtimeEvent<T>) => void) {
    const controller = new AbortController();
    const run = async () => {
      const response = await this.fetcher(`${this.base}${this.api}/realtime`, { headers: this.headers({ accept: "text/event-stream" }), signal: controller.signal, ...this.credentialsFor("caller") });
      if (!response.ok || !response.body) throw new CmsError(response.status, "REALTIME_FAILED", "Could not open the realtime stream.");
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += value;
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const lines = buffer.slice(0, end).split("\n");
          buffer = buffer.slice(end + 2);
          const name = lines.find((line) => line.startsWith("event: "))?.slice(7);
          const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
          if (!name || !data) continue;
          if (name === "PB_CONNECT") await this.request(`${this.api}/realtime`, { method: "POST", body: { clientId: (JSON.parse(data) as { clientId: string }).clientId, subscriptions: [topic] } });
          else if (name === topic) callback(JSON.parse(data) as RealtimeEvent<T>);
        }
      }
    };
    run().catch((error: unknown) => { if (!controller.signal.aborted) console.error("[cms realtime]", error); });
    return () => controller.abort();
  }
}

export const createClient = <C extends object = Record<string, Record<string, unknown>>>(options: ClientOptions = {}) => new CmsClient<C>(options);

const SIGNATURE = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/;

/**
 * Checks a webhook from tansy: its `x-cms-signature` header against the raw body and
 * the secret shown when the webhook was created, and that it was signed within
 * `toleranceSeconds`, so an old delivery can't be replayed. Uses Web Crypto, so it runs in
 * Node, edge runtimes and workers.
 */
export async function verifyWebhook(secret: string, header: string | null, body: string, { toleranceSeconds = 300, now = Date.now() }: { toleranceSeconds?: number; now?: number } = {}) {
  const match = SIGNATURE.exec(header ?? "");
  if (!secret || !match) return false;
  const [, timestamp, signature] = match;
  if (Math.abs(now / 1000 - Number(timestamp)) > toleranceSeconds) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  // Every character is compared, so the time taken doesn't say how much of a guess was right.
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return difference === 0;
}
