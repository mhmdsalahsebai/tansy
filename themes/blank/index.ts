import { defineTheme } from "tansy/theme";

/** The smallest theme that works. It has no styling or blocks of its own, so it makes a starting point to copy. */
export const blank = () => defineTheme({
  name: "blank",
  version: "0.1.0",
  apiVersion: 1,
  render: "@tansy/theme-blank/render",
});
