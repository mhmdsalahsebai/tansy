import type { ByteRange, ByteStream } from "./types";

/** Carries the status only. A provider's answer can quote keys, signatures or the request back. */
export class StorageProviderError extends Error {
  constructor(provider: string, action: string, readonly status?: number) {
    super(status === undefined ? `${provider} couldn't be reached to ${action}.` : `${provider} ${action} failed with status ${status}.`);
    this.name = "StorageProviderError";
  }
}

export interface ProviderCall {
  method?: "GET" | "PUT" | "POST" | "DELETE";
  headers?: Record<string, string>;
  /** A stream is sent as it's read, without buffering, so declare its length in `headers` if the provider needs one. */
  body?: ReadableStream<Uint8Array> | Blob | FormData | URLSearchParams | string;
  /** Statuses that are an answer rather than a failure, such as 404 on a delete. */
  allow?: number[];
}

/**
 * One request to a storage provider. Redirects are refused, so credentials never follow
 * one to another host, and failures carry only the status.
 */
export async function callProvider(provider: string, action: string, url: string | URL, { allow = [], ...init }: ProviderCall = {}, fetcher: typeof fetch = fetch) {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, redirect: "error", ...(init.body instanceof ReadableStream ? { duplex: "half" } : {}) } as RequestInit);
  } catch {
    throw new StorageProviderError(provider, action);
  }
  if (!response.ok && !allow.includes(response.status)) {
    await response.body?.cancel();
    throw new StorageProviderError(provider, action, response.status);
  }
  return response;
}

/** The requested bytes of a response, whether or not the provider honoured the Range header. */
export function rangeOf(response: Response, range: ByteRange | undefined): ByteStream {
  const body = response.body as ByteStream;
  if (!range || response.status === 206) return body;
  let position = 0;
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done || position > range.end) {
          await reader.cancel();
          controller.close();
          return;
        }
        const start = position;
        position += value.length;
        const from = Math.max(range.start - start, 0);
        const to = Math.min(range.end + 1 - start, value.length);
        if (to > from) {
          controller.enqueue(value.subarray(from, to));
          return;
        }
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

/** For providers whose upload API needs the whole body, such as a multipart form. Core bounds upload size. */
export const bodyBlob = (body: ByteStream, contentType: string) => new Response(body, { headers: { "content-type": contentType } }).blob();
