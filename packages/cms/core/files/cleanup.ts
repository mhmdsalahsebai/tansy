import "server-only";
import { HttpError } from "../http/errors";
import prisma from "../../lib/prisma";
import { isPostgres } from "../../lib/prisma/kind";
import { deleteFile } from "./service";

const BATCH = 200;
const DAY_MS = 86_400_000;

/** Stricter than deleteFile, which lets a person remove a file only old history uses. Nobody chose to remove this one. */
async function inAnyRevision(fileId: string) {
  const found = isPostgres()
    ? await prisma.$queryRaw<unknown[]>`SELECT 1 FROM "Revision" WHERE strpos("values"::text, ${fileId}) > 0 LIMIT 1`
    : await prisma.$queryRaw<unknown[]>`SELECT 1 FROM "Revision" WHERE instr("values", ${fileId}) > 0 LIMIT 1`;
  return found.length > 0;
}

/** Removes files uploaded from a form that was then abandoned. Library and API uploads are never temporary. */
export async function purgeUnattachedUploads(retentionDays: number) {
  const cutoff = new Date(Date.now() - retentionDays * DAY_MS);
  let kept = 0;
  for (;;) {
    const batch = await prisma.storedFile.findMany({ where: { temporary: true, createdAt: { lt: cutoff }, refs: { none: {} } }, orderBy: { createdAt: "asc" }, skip: kept, take: BATCH });
    if (!batch.length) return;
    for (const file of batch) {
      if (await inAnyRevision(file.id)) { kept += 1; continue; }
      try {
        await deleteFile(file);
      } catch (error) {
        // A save attached it just now, so it isn't abandoned after all.
        if (!(error instanceof HttpError) || error.status !== 409) throw error;
        kept += 1;
      }
    }
  }
}
