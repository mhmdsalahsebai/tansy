import "server-only";
import type { Prisma } from "../../generated/client-sqlite";
import prisma from "../../lib/prisma";
import { HttpError, notFound } from "../http/errors";
import { resolveFieldConfig } from "./registry";

export interface PresetInput {
  name: string;
  config?: Record<string, unknown>;
}

function resolved(type: string, config: Record<string, unknown> | undefined) {
  const result = resolveFieldConfig(type, config ?? {});
  if (!result.ok) throw new HttpError(400, "VALIDATION_FAILED", "Request validation failed.", result.issues);
  return result.config as Prisma.InputJsonValue;
}

const nameTaken = (error: unknown) => ((error as { code?: string }).code === "P2002" ? new HttpError(409, "CONFLICT", "That preset name is already in use.") : error);

export const listFieldPresets = () => prisma.fieldPreset.findMany({ orderBy: { name: "asc" } });

export async function requireFieldPreset(id: number) {
  const preset = await prisma.fieldPreset.findUnique({ where: { id } });
  if (!preset) throw notFound("Field preset");
  return preset;
}

export async function createFieldPreset(input: PresetInput & { type: string }, createdById: string) {
  const config = resolved(input.type, input.config);
  return prisma.fieldPreset.create({ data: { name: input.name, type: input.type, config, createdById } }).catch((error) => { throw nameTaken(error); });
}

/** The type can't change, because the config is only valid for the type it was written for. */
export async function updateFieldPreset(id: number, input: PresetInput) {
  const current = await requireFieldPreset(id);
  const config = resolved(current.type, input.config);
  return prisma.fieldPreset.update({ where: { id }, data: { name: input.name, config } }).catch((error) => { throw nameTaken(error); });
}

/** Fields made from it are copies, so they aren't affected. */
export async function deleteFieldPreset(id: number) {
  const { name } = await requireFieldPreset(id);
  await prisma.fieldPreset.delete({ where: { id } });
  return name;
}
