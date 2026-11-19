import { defineAdminClient } from "tansy/admin";
import { LivePreview } from "./panel";

export default defineAdminClient({ recordPanels: [{ id: "live-preview", component: LivePreview }] });
