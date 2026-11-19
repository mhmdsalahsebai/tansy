import { defineAdminPlugin } from "tansy/admin";
import { MESSAGES } from "./logic";

/** An envelope, in the navigation's 16 by 16 box. */
const ENVELOPE = {
  paths: ["M1.5 3.5A1.5 1.5 0 0 1 3 2h10a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5v-9Zm1.6-.1L8 7.1l4.9-3.7H3.1ZM13 4.9 8.45 8.35a.75.75 0 0 1-.9 0L3 4.9v7.6h10V4.9Z"],
  fillRule: "evenodd" as const,
};

export default defineAdminPlugin({
  section: {
    title: "Email",
    icon: ENVELOPE,
    items: [{ collection: MESSAGES }, { settings: true }],
  },
});
