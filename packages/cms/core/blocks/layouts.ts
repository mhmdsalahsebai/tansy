import "server-only";
import type { Prisma } from "../../generated/client-sqlite";
import prisma from "../../lib/prisma";
import { HttpError, notFound } from "../http/errors";
import { loadBlockCatalog } from "./service";
import { normalizeBlocks, streamIssues, type Block } from "./stream";

const MAX_LAYOUTS = 200;

export const listBlockLayouts = () => prisma.blockLayout.findMany({ orderBy: { name: "asc" }, take: MAX_LAYOUTS });

/** Checked like a stream, so nothing unreadable is kept. Links and files in it are checked again when a record using it is saved. */
export async function createBlockLayout(input: { name: string; blocks: Block[] }, createdById: string) {
  const catalog = await loadBlockCatalog();
  const blocks = normalizeBlocks(input.blocks, catalog);
  const issues = streamIssues("blocks", blocks, null, catalog);
  if (issues.length) throw new HttpError(400, "VALIDATION_FAILED", "Request validation failed.", issues);
  if (await prisma.blockLayout.count() >= MAX_LAYOUTS) throw new HttpError(409, "CONFLICT", `There can be at most ${MAX_LAYOUTS} layouts. Delete one first.`);
  return prisma.blockLayout.create({ data: { name: input.name, blocks: blocks as unknown as Prisma.InputJsonValue, createdById } }).catch((error) => {
    throw (error as { code?: string }).code === "P2002" ? new HttpError(409, "CONFLICT", "That layout name is already in use.") : error;
  });
}

export async function deleteBlockLayout(id: number) {
  const layout = await prisma.blockLayout.findUnique({ where: { id } });
  if (!layout) throw notFound("Block layout");
  await prisma.blockLayout.delete({ where: { id } });
  return layout.name;
}
