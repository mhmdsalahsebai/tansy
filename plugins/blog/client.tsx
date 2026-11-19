import { defineAdminClient, translate } from "tansy/admin";
import { blockEditors } from "./editors";
import { setCommentState } from "./moderate";

const action = (id: string, label: string, state: "approved" | "spam") => ({
  id,
  label,
  permission: "ext.blog:moderate" as const,
  collections: ["blog-comments"],
  run: async ({ ids, refresh }: { ids: number[]; refresh(): void }) => {
    await setCommentState(ids, state, translate);
    refresh();
  },
});

export default defineAdminClient({
  bulkActions: [action("blog-approve", "Approve", "approved"), action("blog-spam", "Mark as spam", "spam")],
  blockEditors,
});
