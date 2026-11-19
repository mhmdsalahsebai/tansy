import { definePlugin } from "tansy/plugin";

/** Shows your front end beside the record form. The panel stays hidden when `url` is empty, as it is read from NEXT_PUBLIC_TANSY_PREVIEW_URL at build. */
export const livePreview = ({ url }: { url?: string }) => definePlugin({
  name: "live-preview",
  version: "0.1.0",
  apiVersion: 1,
  admin: { client: "@tansy/example-live-preview/client" },
  csp: url ? { frame: [new URL(url).origin] } : undefined,
});
