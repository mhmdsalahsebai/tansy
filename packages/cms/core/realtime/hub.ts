import type { CollectionWithFields } from "../content/access";
import type { RecordRow } from "../content/records";
import { invalidateSiteCache } from "../site/cache";
import { afterResponse } from "../background/after-response";

export interface RecordEvent {
  collection: CollectionWithFields;
  action: "create" | "update" | "delete";
  row: RecordRow;
  /** The record before an update, to tell subscribers when it stops being visible to them. */
  previous?: RecordRow;
}

type Sink = (event: RecordEvent) => Promise<unknown>;

interface HubState {
  dispatch?: (event: RecordEvent) => Promise<void>;
  subscribers: () => number;
  queue: Promise<void>;
  /** Hooks and webhooks. Each has its own queue, so a slow one can't delay the others or realtime. */
  sinks: Map<string, { run: Sink; queue: Promise<unknown> }>;
}

declare const globalThis: { cmsRealtimeHub?: HubState } & typeof global;

/** On globalThis in every environment, because Next.js gives routes and instrumentation separate copies of a module. */
export const hub: HubState = (globalThis.cmsRealtimeHub ??= { subscribers: () => 0, queue: Promise.resolve(), sinks: new Map() });

/** Call after the write has committed. Delivery happens in order and can never fail or slow the write. */
export function emitRecordEvent(event: RecordEvent) {
  // Only the cached site reads that read this collection, which is what the entries remember.
  invalidateSiteCache({ collection: event.collection.id });
  for (const [name, sink] of hub.sinks) {
    sink.queue = sink.queue.then(() => sink.run(event)).catch((error) => console.error(`[${name}]`, error));
    // On a host that stops the function after the response, it stays up until this is delivered.
    const queued = sink.queue;
    afterResponse(name, () => queued);
  }
  if (!hub.dispatch || !hub.subscribers()) return;
  const dispatch = hub.dispatch;
  hub.queue = hub.queue.then(() => dispatch(event)).catch((error) => console.error("[realtime]", error));
}

export function registerSink(name: string, run: Sink) {
  hub.sinks.set(name, { run, queue: Promise.resolve() });
}
