import "server-only";
import { z } from "zod";
import type { Principal } from "../authz/principal";
import { HttpError } from "../http/errors";
import { callTool, toolsFor } from "./tools";

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

export const mcpRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().max(100),
  params: z.record(z.string(), z.unknown()).optional(),
});

type McpRequest = z.output<typeof mcpRequest>;
type Audit = (type: string, id: string, metadata?: Record<string, unknown>) => void;

function toolError(error: unknown) {
  if (!(error instanceof HttpError)) console.error("[mcp]", error);
  const message = error instanceof HttpError ? JSON.stringify({ code: error.code, message: error.message, details: error.details }) : "Something went wrong.";
  return { content: [{ type: "text", text: message }], isError: true };
}

const reply = (id: McpRequest["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });

/** Core's and every plugin's agent tools, the ones this caller may run, each as the caller (core/extend/tools.ts). */
const listTools = (principal: Principal) => toolsFor(principal).map(({ name, description, inputSchema, write }) => ({
  name,
  description,
  inputSchema,
  annotations: { readOnlyHint: !write, destructiveHint: write },
}));

/** Tools run as the caller through scopedRecords, so an agent gets exactly what the same key gets over REST. */
export async function handleMcp(message: McpRequest, principal: Principal, headers: Headers, audit: Audit) {
  if (message.id === undefined) return null; // A notification, which gets no reply.
  switch (message.method) {
    case "initialize": {
      const asked = message.params?.protocolVersion;
      const protocolVersion = SUPPORTED_VERSIONS.includes(asked as string) ? asked : SUPPORTED_VERSIONS[0];
      return reply(message.id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "tansy", version: "1" } });
    }
    case "ping": return reply(message.id, {});
    case "tools/list": return reply(message.id, { tools: listTools(principal) });
    case "tools/call": {
      const name = String(message.params?.name).slice(0, 100);
      audit("tool", name);
      try {
        const result = await callTool(name, message.params?.arguments, principal, headers, "mcp");
        return reply(message.id, { content: [{ type: "text", text: JSON.stringify(result) }] });
      } catch (error) {
        return reply(message.id, toolError(error));
      }
    }
    default: return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } };
  }
}
