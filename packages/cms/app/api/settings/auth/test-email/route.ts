import { route } from "../../../../../core/authz/guard";
import { HttpError } from "../../../../../core/http/errors";
import { authEmail, mailConfigured, sendMail } from "../../../../../core/mail";

export const POST = route(
  { access: "permission", permission: "setting:update", audit: "settings.test_email", rateLimit: { window: 60, max: 5 } },
  async ({ principal, runtime: { settings } }) => {
    if (!(await mailConfigured(settings))) throw new HttpError(400, "MAIL_NOT_CONFIGURED", "Set up email first: SMTP here, or an email plugin's settings.");
    try {
      await sendMail({ ...authEmail(principal.user.email, settings.general.appName, "Test email", "Your email settings are working."), kind: "test" }, settings);
    } catch (error) {
      console.error("[mail] test failed", error);
      throw new HttpError(502, "MAIL_FAILED", "The message couldn't be sent. Check the server log.");
    }
    return null;
  },
);
