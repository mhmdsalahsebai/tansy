import { defineAdminClient, translate } from "tansy/admin";
import { blockEditors } from "./editors";
import { BuilderPanel, enrollByEmail } from "./outline";

export default defineAdminClient({
  recordActions: [{
    id: "lms-enroll",
    label: "Enroll users",
    permission: "ext.lms:enroll",
    collections: ["lms-courses"],
    run: async ({ record }) => {
      const typed = window.prompt(translate("ext.lms.enroll.prompt"));
      if (!typed?.trim()) return;
      window.alert(await enrollByEmail(Number(record.id), typed));
    },
  }],
  recordPanels: [{ id: "lms-builder", component: BuilderPanel }],
  blockEditors,
});
