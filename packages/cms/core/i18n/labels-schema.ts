import { z } from "zod";

/** `labels` in a request or schema file: a name by interface language code, such as { "ar": "المقالات" }. */
export const labelsSchema = (max: number) =>
  z.record(z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/, "Use a language code, such as ar or pt-BR.").max(35), z.string().trim().max(max))
    .refine((labels) => Object.keys(labels).length <= 50, "At most 50 languages.");
