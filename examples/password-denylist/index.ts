import { definePlugin } from "tansy/plugin";

/** Example of `checkPassword`: refuses passwords containing these words. */
export const passwordDenylist = (words: string[]) => definePlugin({
  name: "password-denylist",
  version: "0.1.0",
  apiVersion: 1,
  auth: {
    checkPassword: (password) => (words.some((word) => password.toLowerCase().includes(word.toLowerCase())) ? "That password contains a word this site doesn't allow." : undefined),
  },
});
