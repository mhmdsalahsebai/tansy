/**
 * `tansy` commands that plugins add, such as `tansy tenant`. Core dispatches by name and knows no
 * plugin: it reads `commands` from each plugin in tansy.config.ts, refuses a name of its own and
 * refuses two plugins claiming the same one.
 *
 * A command reaches the instance only over HTTP, as the API key in `TANSY_API_KEY`, never by opening
 * the database. So every write goes through the same guard, permissions, rules and audit log as any
 * other request, a command can do no more than that key may, and a route that asks for a recent
 * sign-in stays closed to it. The server has to be running, which is the trade and is worth it.
 */
import { loadCmsConfig } from "./sync.mjs";

const NAME = /^[a-z][a-z0-9-]*$/;

/** Every plugin command in this app, by name, with the plugin that added it. */
export function pluginCommands(cwd, reserved) {
  const found = new Map();
  for (const plugin of loadCmsConfig(cwd).plugins ?? []) {
    for (const command of plugin.commands ?? []) {
      if (!NAME.test(command.name ?? "")) throw new Error(`The plugin "${plugin.name}" adds a command called ${JSON.stringify(command.name)}. A command's name is lower-case letters, digits and hyphens.`);
      if (reserved.includes(command.name)) throw new Error(`The plugin "${plugin.name}" adds a command called "${command.name}", which is one of cms's own. Only the plugin's name can change here.`);
      const claimed = found.get(command.name);
      if (claimed) throw new Error(`The plugins "${claimed.plugin}" and "${plugin.name}" both add "cms ${command.name}". Only one plugin can have a command's name.`);
      found.set(command.name, { plugin: plugin.name, command });
    }
  }
  return found;
}

/** The server a command talks to: --url, else TANSY_URL, else the app's own public address. */
const serverUrl = (flags) => flags.url ?? process.env.TANSY_URL ?? process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

function apiFor(plugin, name, flags, fail) {
  const url = serverUrl(flags);
  const base = new URL(`${process.env.NEXT_PUBLIC_TANSY_API_PATH ?? "/api"}/ext/${plugin}`, url);
  // Asked for on the first request, not when the context is made, so `tansy <name>` can still print
  // its own usage, and a command that needs no request needs no key.
  const apiKey = () => process.env.TANSY_API_KEY
    || fail(`Set TANSY_API_KEY to an API key of this instance. "cms ${name}" works through the API, as that key, so it can do only what the key may.`);

  const send = async (path, init = {}) => {
    const key = apiKey();
    const target = new URL(base.pathname.replace(/\/$/, "") + path, base);
    let response;
    try {
      response = await fetch(target, {
        method: init.method ?? "GET",
        headers: { "x-api-key": key, ...(init.headers ?? {}) },
        body: init.body,
      });
    } catch (error) {
      return fail(`No answer from ${url}: ${error.message}. Start the server, or pass --url.`);
    }
    return response;
  };

  return {
    url,
    async request(path, init = {}) {
      const headers = init.body === undefined ? init.headers : { "content-type": "application/json", ...(init.headers ?? {}) };
      const response = await send(path, { ...init, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
      const text = await response.text();
      let payload = null;
      try { payload = JSON.parse(text); } catch { /* not json */ }
      if (!response.ok) {
        const message = payload?.error?.message ?? text.slice(0, 400) ?? "";
        return fail(`The server answered ${response.status}${payload?.error?.code ? ` ${payload.error.code}` : ""}: ${message}`);
      }
      return payload;
    },
    fetch: (path, init) => send(path, init),
  };
}

/** Runs one plugin command, with the context core promises it (PluginCommand in core/extend/define.ts). */
export async function runPluginCommand({ plugin, command }, { args, flags, fail, log = console.log }) {
  await command.run({
    args,
    flags,
    api: apiFor(plugin, command.name, flags, fail),
    log,
    fail,
  });
}
