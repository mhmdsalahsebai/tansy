import { BlockList, isIP } from "node:net";
import { definePlugin } from "tansy/plugin";

function parse(entries: string[]) {
  const list = new BlockList();
  for (const entry of entries) {
    const [address, bits] = entry.split("/");
    const family = isIP(address) === 6 ? "ipv6" : "ipv4";
    if (!isIP(address)) throw new Error(`IP allowlist: "${entry}" is not an address or range.`);
    if (bits === undefined) list.addAddress(address, family);
    else list.addSubnet(address, Number(bits), family);
  }
  return list;
}

/**
 * Example of `guardRequest`: dashboard staff only reach the system from these
 * addresses. It relies on the client IP header under Settings, so run it behind a
 * proxy that overwrites that header. A request with no address is refused unless
 * `allowUnknown` is set.
 */
export function ipAllowlist(entries: string[], { allowUnknown = false } = {}) {
  const list = parse(entries);
  return definePlugin({
    name: "ip-allowlist",
    version: "0.1.1",
    apiVersion: 1,
    auth: {
      guardRequest: ({ principal, ip }) => {
        if (principal.kind !== "user" || !principal.permissions.has("dashboard:access")) return;
        if (!ip) return allowUnknown ? undefined : false;
        const family = isIP(ip);
        return family !== 0 && list.check(ip, family === 6 ? "ipv6" : "ipv4") ? undefined : false;
      },
    },
  });
}
