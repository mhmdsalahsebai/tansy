import { defineAdminPlugin } from "tansy/admin";
import { Assistant } from "./assistant";
import { Workflows } from "./workflow/page";

/** A four-pointed spark, in the navigation's 16 by 16 box. */
const SPARK = {
  paths: ["M8 1.25a.75.75 0 0 1 .72.54l.9 3.06a2.25 2.25 0 0 0 1.53 1.53l3.06.9a.75.75 0 0 1 0 1.44l-3.06.9a2.25 2.25 0 0 0-1.53 1.53l-.9 3.06a.75.75 0 0 1-1.44 0l-.9-3.06a2.25 2.25 0 0 0-1.53-1.53l-3.06-.9a.75.75 0 0 1 0-1.44l3.06-.9a2.25 2.25 0 0 0 1.53-1.53l.9-3.06A.75.75 0 0 1 8 1.25Z"],
};

export default defineAdminPlugin({
  pages: [
    { path: "ai", title: "Assistant", permission: "ext.ai:use", component: () => <Assistant /> },
    { path: "ai-workflows", title: "Workflows", permission: "ext.ai:workflows", component: () => <Workflows /> },
  ],
  section: { title: "AI", icon: SPARK, items: [{ page: "ai" }, { page: "ai-workflows" }, { settings: true }] },
  // The assistant from any page, at the end of the top bar.
  shortcut: { page: "ai", title: "Ask AI", icon: SPARK },
});
