import "server-only";
import prisma from "../../lib/prisma";
import { rolePermissions, SUPERADMIN } from "../authz/roles";
import { listLocales } from "./locales";

const GRANTED = "migration:locale-edit";

/**
 * Runs once. Roles made before languages existed could write every record, so they
 * keep that: each role holding a record write permission gets `locale:edit`. A role
 * changed by hand afterwards stays as its owner left it.
 */
export async function grantLocaleEdit() {
  if (await prisma.appSetting.findUnique({ where: { key: GRANTED } })) return false;
  let changed = false;
  for (const role of await prisma.role.findMany()) {
    if (role.name === SUPERADMIN) continue;
    const permissions = rolePermissions(role);
    const writes = permissions.some((permission) => /^record:(create|update)(@c\d+(:own)?)?$/.test(permission));
    if (!writes || permissions.includes("locale:edit")) continue;
    await prisma.role.update({ where: { name: role.name }, data: { permissions: [...permissions, "locale:edit"] } });
    changed = true;
  }
  await prisma.appSetting.create({ data: { key: GRANTED, value: { at: new Date().toISOString() } } });
  return changed;
}

/** Makes sure the first language exists, and that roles can write in it. */
export async function prepareLocalization() {
  await listLocales();
  if (await grantLocaleEdit()) {
    const [{ bumpAuthRevision }, { invalidateRuntime }] = await Promise.all([import("../auth/settings"), import("../auth/instance")]);
    await bumpAuthRevision();
    invalidateRuntime();
  }
}
