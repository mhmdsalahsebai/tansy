import { notFound } from "../http/errors";

export function parseId(value: string): number {
  const id = /^\d{1,10}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(id) || id > 2147483647) throw notFound();
  return id;
}
