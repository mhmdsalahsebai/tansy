"use client";

import { useEffect, useRef } from "react";
import { api } from "./api";
import { apiPath } from "../paths";

/** Calls onEvent for each event on the topic. Reconnects by itself, and subscribes again each time it does. */
export function useRealtime(topic: string | null, onEvent: () => void) {
  const latest = useRef(onEvent);
  useEffect(() => { latest.current = onEvent; });

  useEffect(() => {
    if (!topic) return;
    const source = new EventSource(apiPath("/realtime"));
    source.addEventListener("PB_CONNECT", (event) => {
      const { clientId } = JSON.parse((event as MessageEvent<string>).data) as { clientId: string };
      void api(apiPath("/realtime"), { method: "POST", body: { clientId, subscriptions: [topic] } }).catch(() => {});
    });
    source.addEventListener(topic, () => latest.current());
    return () => source.close();
  }, [topic]);
}
