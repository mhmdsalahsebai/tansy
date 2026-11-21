import { createHash } from "node:crypto";
import { z } from "zod";
import { convertToModelMessages, createUIMessageStreamResponse, dynamicTool, generateId, generateText, isStepCount, jsonSchema, Output, streamText, toUIMessageStream, validateUIMessages, type ToolSet, type UIMessage } from "ai";
import { apiPath, definePlugin, defineRoute, mergeMessagesByLanguage, type ExtensionRouteContext, type ExtensionTools, type PluginSettingField } from "tansy/plugin";
import { CHAT_ID, chatStore } from "./chats";
import { fillSchema, fillValues, forModel, jsonInstructions, systemPrompt, textOf, WRITE_ACTIONS, writePrompt, type DescribedField, type WriteAction } from "./logic";
import { chatModels, imageModels, ModelListError, type AiProvider, type AiSettings, type ModelCapabilities } from "./provider";
import { attachmentIdOf, attachmentStore, ATTACHMENT_ID } from "./attachments";
import { acceptedTypes, ATTACHMENT_TYPES, attachmentType, MAX_ATTACHMENT_BYTES, readableKinds } from "./media";
import { ASPECT_RATIOS, drawPicture, NoPicture } from "./images";
import { messages } from "./messages";
import { providerReason } from "./errors";
import { capabilitiesOf, listModels } from "./models";
import { workflowJob, workflowRoutes } from "./workflow/routes";
import { ASSISTANT_ROLE, assistantRole, givesRoles, ROLE_NAME, roleFor } from "./role";

export type { AiProvider, AiSettings } from "./provider";
export { WORKFLOWS } from "./workflow/routes";
export { ASSISTANT_ROLE } from "./role";
export type { Workflow } from "./workflow/schema";

export interface AiOptions {
  /**
   * The model providers the site can use, each from its own package, such as `openai()`
   * from @tansy/ai-openai. Owners choose one under AI → Settings.
   */
  providers: AiProvider[];
  /** Which of them is used until changed under AI → Settings. The first when left out. */
  provider?: string;
}

const PROVIDER_ID = /^[a-z][a-z0-9]{0,19}$/;

const optionsSchema = z.strictObject({
  providers: z.array(z.object({ id: z.string().regex(PROVIDER_ID, "A provider's id is lowercase letters and digits."), label: z.string().min(1) }).loose()).min(1, "Add at least one provider, such as openai() from @tansy/ai-openai."),
  provider: z.string(),
}).superRefine((value, issues) => {
  const ids = value.providers.map((provider) => provider.id);
  const twice = ids.find((id, index) => ids.indexOf(id) !== index);
  if (twice) issues.addIssue({ code: "custom", path: ["providers"], message: `The provider "${twice}" is listed twice.` });
  if (!ids.includes(value.provider)) issues.addIssue({ code: "custom", path: ["provider"], message: `"${value.provider}" isn't one of the providers listed.` });
});

/** Using the assistant, filling forms and writing fields. Each acts with the person's own access, so it grants nothing else. */
export const USE = "ext.ai:use";

/** The model setting's description in other languages, which names each provider's default model as the English one does. ICU's quote character is doubled. */
const modelWords = (providers: AiProvider[]) => ({
  // A provider's name is its brand, the same in every language.
  ar: { settings: { imageProvider: { options: Object.fromEntries(providers.map((provider) => [provider.id, provider.label])) }, model: { description: `معرّف النموذج لدى ذلك المزوّد. الفارغ يستخدم النموذج الافتراضي للمزوّد: ${providers.map((provider) => `${provider.label}، ${provider.defaultModel || "لا يوجد"}`).join("؛ ").replace(/'/g, "''").replace(/[{}]/g, "")}.` } } },
});

/** The model settings offer the chosen provider's models, from GET /models. */
const MODEL_CHOICES = { route: "/models", with: ["provider"] };

/** Who may list a provider's models: whoever may change the plugin's settings, as listing uses the saved key. */
const SETTINGS = "setting:update";

/** How hard a model thinks before it answers, as the AI SDK names it. Providers without thinking ignore it. */
export const REASONING = ["provider-default", "none", "low", "medium", "high"] as const;
export type Reasoning = (typeof REASONING)[number];

/** A model id as providers write them: "gpt-6", "anthropic/claude-opus-5-5", "llama3.3:70b". */
const MODEL_ID = /^[A-Za-z0-9][\w.:/@+-]{0,199}$/;

/** The picture setting's choice for the assistant's own provider. */
const SAME = "same";

/** The provider a setting names, or the assistant's own for "same" or nothing. */
const providerOf = (value: string | undefined, fallback: string) => (value && value !== SAME ? value : fallback);

const sharedSettings = (value: { provider: string }, providers: AiProvider[]): PluginSettingField[] => [
  { name: "provider", type: "select", default: value.provider, label: "Provider", description: "Who runs the model. Fill in that provider's settings below.", options: providers.map((provider) => ({ value: provider.id, label: provider.label })) },
  { name: "model", type: "text", default: "", maxLength: 200, suggestions: MODEL_CHOICES, label: "Model", description: `The model's id at that provider. Empty uses the provider's default: ${providers.map((provider) => `${provider.label}, ${provider.defaultModel || "none"}`).join("; ")}.` },
  { name: "fastModel", type: "text", default: "", maxLength: 200, suggestions: MODEL_CHOICES, label: "Model for writing fields", description: "A quicker, cheaper model for writing and improving one field. Empty uses the model above." },
  { name: "imageProvider", type: "select", default: SAME, label: "Provider for pictures", description: "Who draws pictures when someone asks the assistant for one. Workflows choose their own.", options: [{ value: SAME, label: "The provider above" }, ...providers.map((provider) => ({ value: provider.id, label: provider.label }))] },
  { name: "imageModel", type: "text", default: "", maxLength: 200, suggestions: { route: "/image-models", with: ["provider", "imageProvider"] }, label: "Model for pictures", description: "The model that draws in the chat: an image model, such as gpt-image-2, or one that answers with pictures, such as a Gemini image model. Empty: the assistant doesn't draw." },
  { name: "chooseModel", type: "boolean", default: true, label: "People choose the model in the chat", description: "The assistant offers every model the key can use, and how long it thinks. Off keeps everyone on the model above." },
  { name: "reasoning", type: "select", default: "provider-default", label: "Thinking", description: "How long the assistant thinks before it answers, on models that can. People can change it in the chat when they choose the model.", options: [
    { value: "provider-default", label: "The model's default" },
    { value: "none", label: "Off" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
  ] },
  { name: "role", type: "text", default: ASSISTANT_ROLE, maxLength: 40, suggestions: { route: "/roles" }, label: "Role the AI acts with", description: "The AI can do only what this role and the person using it may both do. AI assistant, made with the plugin, reads and drafts content; change what it may do under Roles, or choose another role." },
  { name: "chooseRole", type: "boolean", default: true, label: "Admins choose the role in the chat", description: "Lets people who may give users roles, admins by default, give the assistant another role for a chat. It still never gets more than their own access." },
  { name: "instructions", type: "text", default: "", maxLength: 4000, multiline: true, label: "Site guidance", description: "Added to every request: who the site is for, its tone, words to use or avoid." },
  { name: "maxSteps", type: "number", default: 12, min: 1, max: 50, integer: true, label: "Most tool calls per answer", description: "How many tool calls the assistant may make before it stops and answers." },
  { name: "maxOutputTokens", type: "number", default: 4000, min: 256, max: 64000, integer: true, label: "Longest answer (tokens)" },
];

function providerSettings(providers: AiProvider[]) {
  return providers.flatMap((provider) => provider.settings().map((field) => {
    if (!field.name.startsWith(provider.id)) throw new Error(`AI provider "${provider.id}": the setting "${field.name}" must start with "${provider.id}".`);
    return field;
  }));
}

const refuse = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status });

/**
 * Signs approvals the server asked for, so a request can't carry an approval the person
 * never gave. Derived from the auth secret under its own label, so it is no other key.
 */
const approvalSecret = () => {
  const secret = process.env.BETTER_AUTH_SECRET;
  return secret ? createHash("sha256").update(`tansy:ai-tool-approval:${secret}`).digest() : undefined;
};

/** A provider's message can quote the site's account, so it stays in the server log. */
function providerFailed(error: unknown) {
  console.error("[ai] the provider failed", error);
  return refuse(502, "AI_PROVIDER_FAILED", providerReason(error));
}

/** An error a tool threw for the caller, such as a refused rule, as the API would give it. Anything else stays in the log. */
function toolFailure(error: unknown) {
  const known = error as { status?: unknown; code?: unknown; message?: unknown; details?: unknown };
  if (typeof known?.status === "number" && typeof known.code === "string") return { error: { code: known.code, message: String(known.message), details: known.details } };
  console.error("[ai] a tool failed", error);
  return { error: { code: "TOOL_FAILED", message: "Something went wrong running that tool." } };
}

const chatId = z.string().regex(CHAT_ID);

/** Reads a request's body up to `max` bytes, or null when it is longer. */
async function readLimited(request: Request, max: number): Promise<Buffer | null> {
  if (Number(request.headers.get("content-length") ?? 0) > max) return null;
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** A file name safe to keep and to send back in a header. */
const cleanName = (name: string) => name.normalize("NFKC").replace(/[^\p{L}\p{N}._ -]+/gu, "-").replace(/\s+/g, " ").trim().slice(0, 120) || "file";

const KIND_WORDS: Record<string, string> = { image: "pictures", file: "PDFs", audio: "sound", video: "video" };

/** All a chat's files sent to a model, at most: older ones past it are named rather than sent. */
const FILES_BUDGET = 24 * 1024 * 1024;

type Part = UIMessage["parts"][number];

/**
 * The conversation as the model gets it. The chat's files are the person's own attachments,
 * read from the store: a file part pointing anywhere else is refused, so the server never
 * fetches an address a request names. Text files become text, files the model can't read
 * are named instead, and files from earlier messages past the budget are named too.
 */
async function withFiles(messages: UIMessage[], read: (id: string) => Promise<{ mediaType: string; name: string; data: Buffer } | null>, capabilities: ModelCapabilities, modelId: string): Promise<UIMessage[] | Response> {
  const kinds = readableKinds(capabilities);
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  let budget = FILES_BUDGET;
  const out: UIMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message.parts.some((part) => part.type === "file")) { out.unshift(message); continue; }
    // Only the person attaches files. Anything else claiming one is dropped.
    if (message.role !== "user") { out.unshift({ ...message, parts: message.parts.filter((part) => part.type !== "file") }); continue; }
    const parts: Part[] = [];
    for (const part of message.parts) {
      if (part.type !== "file") { parts.push(part); continue; }
      const id = attachmentIdOf(part.url);
      if (!id) return refuse(400, "BAD_ATTACHMENT", "A file in the chat can't be read. Attach it again.");
      const file = await read(id);
      const name = file?.name ?? part.filename ?? "file";
      if (!file) { parts.push({ type: "text", text: `[The person attached "${name}", which is no longer kept.]` }); continue; }
      const kind = ATTACHMENT_TYPES[file.mediaType];
      if (kind === "text") {
        parts.push({ type: "text", text: `The person attached "${name}":\n\n\`\`\`\n${file.data.toString("utf8").slice(0, 100_000)}\n\`\`\`` });
        continue;
      }
      if (!kind || !kinds.has(kind)) {
        if (index === lastUser && capabilities.reported) return refuse(400, "AI_CANT_READ", `${modelId} can't read ${KIND_WORDS[kind ?? ""] ?? "this kind of file"}. Choose a model that can, or remove the file.`);
        parts.push({ type: "text", text: `[The person attached "${name}", which this model can't read.]` });
        continue;
      }
      if (file.data.byteLength > budget) { parts.push({ type: "text", text: `[The person attached "${name}" earlier in the chat.]` }); continue; }
      budget -= file.data.byteLength;
      parts.push({ type: "file", mediaType: file.mediaType, filename: name, url: `data:${file.mediaType};base64,${file.data.toString("base64")}` });
    }
    out.unshift({ ...message, parts });
  }
  return out;
}

/** Whose chats these are. The routes need the AI permission, which only a signed-in person can hold. */
const ownerOf = (context: ExtensionRouteContext<unknown, unknown>) => (context.principal.kind === "user" ? context.principal.user.id : null);

const page = z.object({ collection: z.string().max(63).optional(), recordId: z.string().max(20).optional() }).optional();

/**
 * An assistant in the dashboard on the Vercel AI SDK, with any model provider an adapter
 * package brings. It chats, fills a record's form from a prompt, writes and improves single
 * fields, and does anything an agent tool can, from core or any plugin, as the signed-in
 * person, asking before every write. See docs/plugins/ai.md.
 */
export function ai(options: AiOptions) {
  const value = optionsSchema.parse({ provider: options.providers?.[0]?.id, ...Object.fromEntries(Object.entries(options).filter(([, option]) => option !== undefined)) });
  const providers = options.providers;
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const fields = [...sharedSettings(value, providers), ...providerSettings(providers)];

  /**
   * The model to use, or the response explaining why there isn't one. `picked` is the model,
   * and `pickedProvider` the provider, the person chose in the chat, used only while the
   * settings let people choose. Another provider than the site's starts on its own default model.
   */
  async function modelFor(context: ExtensionRouteContext<unknown, unknown>, kind: "main" | "fast", picked?: string, pickedProvider?: string) {
    const settings = (await context.settings.get()) as unknown as AiSettings;
    const own = byId.get(settings.provider);
    if (!own || !own.ready(settings)) return { refused: refuse(503, "AI_NOT_SET_UP", `AI isn't set up yet. Add the ${own?.label ?? "provider"} settings under AI → Settings.`) } as const;
    const choosing = settings.chooseModel !== false;
    const other = choosing && pickedProvider && pickedProvider !== own.id ? byId.get(pickedProvider) : undefined;
    if (choosing && pickedProvider && pickedProvider !== own.id && (!other || !other.ready(settings))) return { refused: refuse(400, "AI_PROVIDER_NOT_SET_UP", `${other?.label ?? "That provider"} isn't set up. Choose another provider in the chat.`) } as const;
    const provider = other ?? own;
    const chosen = choosing && picked ? picked : "";
    const id = chosen || (other ? other.defaultModel : (kind === "fast" && settings.fastModel.trim()) || settings.model.trim() || own.defaultModel);
    if (!id) return { refused: refuse(503, "AI_NOT_SET_UP", "Choose a model under AI → Settings.") } as const;
    return { model: provider.model(settings, id), settings, provider, modelId: id } as const;
  }

  /** The model that draws in the chat, or null when the settings choose none or its provider isn't set up. */
  const drawerFor = (settings: AiSettings) => {
    const modelId = (settings.imageModel ?? "").trim();
    const provider = byId.get(providerOf(settings.imageProvider, settings.provider));
    return modelId && provider && provider.ready(settings) ? { provider, modelId } : null;
  };

  /** The thinking a chat asks for: the person's choice while they may choose, else the settings'. */
  const reasoningFor = (settings: AiSettings, picked?: Reasoning): Reasoning | undefined => {
    const reasoning = (settings.chooseModel !== false && picked) || settings.reasoning;
    return reasoning && reasoning !== "provider-default" && (REASONING as readonly string[]).includes(reasoning) ? reasoning as Reasoning : undefined;
  };

  const describe = async (context: ExtensionRouteContext<unknown, unknown>, collection: string) =>
    (await context.tools.call("describe_collection", { collection })) as { slug: string; name: string; fields: DescribedField[] };

  return definePlugin({
    name: "ai",
    version: "0.1.1",
    messages: mergeMessagesByLanguage(messages, ...providers.map((provider) => provider.messages), modelWords(providers)),
    apiVersion: 1,
    requires: { cms: "^0.1.1" },
    admin: { server: "@tansy/ai/admin", client: "@tansy/ai/client" },
    options: { schema: optionsSchema, value },
    settings: { fields },
    permissions: { "ext.ai": ["use", "workflows"] },
    migrations: [{ id: "001-assistant-role", up: async ({ roles }) => { await roles.ensure(assistantRole); } }],
    jobs: [workflowJob(providers)],
    routes: [
      ...workflowRoutes(providers),
      defineRoute({
        method: "GET",
        path: "/status",
        access: "permission",
        permission: USE,
        handler: async (context) => {
          const chosen = await modelFor(context, "main");
          if ("refused" in chosen) return { ready: false };
          const { settings, provider } = chosen;
          return {
            ready: true,
            provider: provider.id,
            providerLabel: provider.label,
            model: chosen.modelId,
            reasoning: (REASONING as readonly string[]).includes(settings.reasoning) ? settings.reasoning : "provider-default",
            providerIcon: provider.icon,
            chooseModel: settings.chooseModel !== false,
            listsModels: Boolean(provider.models),
            role: roleFor(settings),
            // The providers set up, for the person to switch between while they may choose the model.
            providers: settings.chooseModel === false ? [] : providers.filter((item) => item.ready(settings)).map((item) => ({
              id: item.id,
              label: item.label,
              icon: item.icon,
              model: item.id === provider.id ? chosen.modelId : item.defaultModel,
              listsModels: Boolean(item.models),
            })),
            // Only someone who may give people roles may give the AI one.
            chooseRole: settings.chooseRole !== false && givesRoles(context.principal),
          };
        },
      }),
      defineRoute({
        method: "POST",
        path: "/chat",
        access: "permission",
        permission: USE,
        audit: "ai.chat",
        rateLimit: { window: 60, max: 30 },
        body: z.object({ messages: z.array(z.unknown()).min(1).max(100), page, chatId: chatId.optional(), provider: z.string().regex(PROVIDER_ID).optional(), model: z.string().regex(MODEL_ID).optional(), reasoning: z.enum(REASONING).optional(), role: z.string().regex(ROLE_NAME).optional() }),
        handler: async (context) => {
          const chosen = await modelFor(context, "main", context.body.model, context.body.provider);
          if ("refused" in chosen) return chosen.refused;
          const { model, settings } = chosen;
          if (context.body.role && !givesRoles(context.principal)) return refuse(403, "FORBIDDEN", "Only someone who may give people roles may choose the AI's role.");
          // The AI gets what both the person and its role may do, so a role can only take access away.
          const role = roleFor(settings, context.body.role);
          let scoped: ExtensionTools;
          try {
            scoped = await context.tools.withRole(role);
          } catch {
            return refuse(400, "AI_ROLE_MISSING", `The AI's role "${role}" doesn't exist any more. Choose another under AI → Settings or in the chat.`);
          }
          const available = await scoped.list();
          const writes = new Set(available.filter((tool) => tool.write).map((tool) => tool.name));
          const tools: ToolSet = Object.fromEntries(available.map((tool) => [tool.name, dynamicTool({
            description: tool.description,
            inputSchema: jsonSchema(tool.inputSchema as Parameters<typeof jsonSchema>[0]),
            execute: async (input) => {
              try {
                return forModel(await scoped.call(tool.name, input));
              } catch (error) {
                return toolFailure(error);
              }
            },
          })]));
          const userId = ownerOf(context);
          const files = attachmentStore(context.store);
          const drawer = drawerFor(settings);
          if (drawer && userId && !tools.generate_image) {
            tools.generate_image = dynamicTool({
              description: "Draws a picture from a description and shows it to the person in the chat. Describe the subject, style, colours and composition. Use it only when the person asks for a picture.",
              inputSchema: jsonSchema({ type: "object", properties: { prompt: { type: "string", minLength: 1, maxLength: 4000, description: "What to draw, in detail." }, aspectRatio: { type: "string", enum: [...ASPECT_RATIOS], description: "The picture's shape. 1:1 when unsure." } }, required: ["prompt"], additionalProperties: false }),
              execute: async (input) => {
                const { prompt, aspectRatio } = input as { prompt: string; aspectRatio?: (typeof ASPECT_RATIOS)[number] };
                try {
                  const picture = await drawPicture({ ...drawer, settings, prompt: String(prompt).slice(0, 4000), aspectRatio: ASPECT_RATIOS.includes(aspectRatio as never) ? aspectRatio : undefined, abortSignal: AbortSignal.any([context.request.signal, AbortSignal.timeout(5 * 60_000)]) });
                  const mediaType = ATTACHMENT_TYPES[picture.mediaType] === "image" ? picture.mediaType : "image/png";
                  const name = `${cleanName(String(prompt).toLowerCase().split(/\s+/).slice(0, 6).join("-")).replace(/ /g, "-")}.${mediaType.split("/")[1].replace("jpeg", "jpg")}`;
                  const id = await files.put(userId, { data: picture.bytes, mediaType, name, drawn: true });
                  return { image: { url: apiPath(`/ext/ai/attachments/${id}`), mediaType, name }, model: drawer.modelId };
                } catch (error) {
                  if (error instanceof NoPicture) return { error: { code: "AI_NO_PICTURE", message: error.message } };
                  console.error("[ai] drawing failed", error);
                  return { error: { code: "AI_IMAGE_FAILED", message: providerReason(error) } };
                }
              },
            });
          }
          let messages: UIMessage[];
          try {
            messages = await validateUIMessages({ messages: context.body.messages, tools: tools as never });
          } catch {
            return refuse(400, "BAD_REQUEST", "The conversation couldn't be read. Start a new one.");
          }
          const user = context.principal.kind === "anonymous" ? "the signed-in person" : context.principal.user.name || context.principal.user.email;
          const reasoning = reasoningFor(settings, context.body.reasoning);
          const attached = messages.some((message) => message.parts.some((part) => part.type === "file"));
          if (attached && !userId) return refuse(400, "BAD_ATTACHMENT", "Only a signed-in person can attach files.");
          const forModelMessages = attached
            ? await withFiles(messages, (id) => files.get(userId!, id), await capabilitiesOf(chosen.provider, settings, chosen.modelId), chosen.modelId)
            : messages;
          if (forModelMessages instanceof Response) return forModelMessages;
          context.auditTarget("ai", chosen.provider.id, { model: chosen.modelId, role, ...(reasoning ? { reasoning } : {}), ...(attached ? { files: true } : {}) });
          const saveTo = userId && context.body.chatId ? context.body.chatId : null;
          try {
            const result = streamText({
              model,
              system: systemPrompt({ userName: user, role, instructions: settings.instructions, page: context.body.page, draws: Boolean(tools.generate_image) }),
              messages: await convertToModelMessages(forModelMessages, { tools, ignoreIncompleteToolCalls: true }),
              tools,
              // Every write waits for the person, so text the model read can't make it change anything on its own.
              toolApproval: ({ toolCall }) => (writes.has(toolCall.toolName) ? "user-approval" : undefined),
              experimental_toolApprovalSecret: approvalSecret(),
              stopWhen: isStepCount(settings.maxSteps),
              maxOutputTokens: settings.maxOutputTokens,
              ...(reasoning ? { reasoning } : {}),
              abortSignal: context.request.signal,
            });
            return createUIMessageStreamResponse({
              stream: toUIMessageStream({
                stream: result.stream,
                originalMessages: messages,
                sendReasoning: true,
                // Which model answered, for the answer's footer.
                messageMetadata: ({ part }) => (part.type === "start" ? { model: chosen.modelId, provider: chosen.provider.id } : undefined),
                generateMessageId: generateId,
                // Saved when the answer ends, however it ends, so the chat is there after a reload.
                onEnd: async ({ messages: finished }) => {
                  if (!saveTo || !userId) return;
                  try {
                    await chatStore(context.store).save(userId, saveTo, finished);
                  } catch (error) {
                    console.error("[ai] could not save the chat", error);
                  }
                },
                onError: (error) => {
                  console.error("[ai] the provider failed", error);
                  return providerReason(error);
                },
              }),
              headers: { "cache-control": "no-store" },
            });
          } catch (error) {
            return providerFailed(error);
          }
        },
      }),
      defineRoute({
        method: "GET",
        path: "/models",
        access: "permission",
        permission: SETTINGS,
        query: z.object({ provider: z.string().max(20).optional() }),
        rateLimit: { window: 60, max: 30 },
        handler: async (context) => {
          const settings = (await context.settings.get()) as unknown as AiSettings;
          const provider = byId.get(context.query.provider || settings.provider);
          if (!provider) return refuse(404, "NOT_FOUND", "There's no such provider.");
          if (!provider.models) return { options: [] };
          if (!provider.ready(settings)) return refuse(400, "AI_NOT_SET_UP", `Save the ${provider.label} settings first, then reload the choices.`);
          try {
            return { options: chatModels(await provider.models(settings)).slice(0, 2000).map(({ value, label }) => ({ value, label })) };
          } catch (error) {
            if (error instanceof ModelListError) return refuse(502, "AI_MODELS_FAILED", error.message);
            console.error("[ai] could not list models", error);
            return refuse(502, "AI_MODELS_FAILED", "The provider's models couldn't be listed.");
          }
        },
      }),
      defineRoute({
        method: "GET",
        path: "/chat/models",
        access: "permission",
        permission: USE,
        query: z.object({ provider: z.string().regex(PROVIDER_ID).optional() }),
        rateLimit: { window: 60, max: 20 },
        handler: async (context) => {
          // The models the person may choose from in the chat, from the provider they chose. Only ids and names: never the key.
          const settings = (await context.settings.get()) as unknown as AiSettings;
          const provider = byId.get(context.query.provider || settings.provider);
          if (!provider || !provider.ready(settings) || settings.chooseModel === false || !provider.models) return { options: [] };
          try {
            return { options: chatModels(await listModels(provider, settings)).map(({ value, label }) => ({ value, label })) };
          } catch (error) {
            if (error instanceof ModelListError) return refuse(502, "AI_MODELS_FAILED", error.message);
            console.error("[ai] could not list models", error);
            return refuse(502, "AI_MODELS_FAILED", "The provider's models couldn't be listed.");
          }
        },
      }),
      defineRoute({
        method: "GET",
        path: "/chat/capabilities",
        access: "permission",
        permission: USE,
        query: z.object({ model: z.string().regex(MODEL_ID).optional(), provider: z.string().regex(PROVIDER_ID).optional() }),
        rateLimit: { window: 60, max: 60 },
        handler: async (context) => {
          // What the chat's model reads, for the composer to offer only files it can send.
          const chosen = await modelFor(context, "main", context.query.model, context.query.provider);
          if ("refused" in chosen) return chosen.refused;
          const capabilities = await capabilitiesOf(chosen.provider, chosen.settings, chosen.modelId);
          return { model: chosen.modelId, accept: acceptedTypes(capabilities), reported: Boolean(capabilities.reported), maxBytes: MAX_ATTACHMENT_BYTES, draws: Boolean(drawerFor(chosen.settings)) };
        },
      }),
      defineRoute({
        method: "GET",
        path: "/image-models",
        access: "permission",
        permission: SETTINGS,
        query: z.object({ provider: z.string().max(20).optional(), imageProvider: z.string().max(20).optional() }),
        rateLimit: { window: 60, max: 30 },
        handler: async (context) => {
          // The models that draw, for the picture setting to offer.
          const settings = (await context.settings.get()) as unknown as AiSettings;
          const provider = byId.get(context.query.imageProvider || context.query.provider ? providerOf(context.query.imageProvider, context.query.provider || settings.provider) : providerOf(settings.imageProvider, settings.provider));
          if (!provider) return refuse(404, "NOT_FOUND", "There's no such provider.");
          if (!provider.models) return { options: [] };
          if (!provider.ready(settings)) return refuse(400, "AI_NOT_SET_UP", `Save the ${provider.label} settings first, then reload the choices.`);
          try {
            return { options: imageModels(await provider.models(settings)).slice(0, 2000).map(({ value, label }) => ({ value, label })) };
          } catch (error) {
            if (error instanceof ModelListError) return refuse(502, "AI_MODELS_FAILED", error.message);
            console.error("[ai] could not list models", error);
            return refuse(502, "AI_MODELS_FAILED", "The provider's models couldn't be listed.");
          }
        },
      }),
      defineRoute({
        method: "POST",
        path: "/attachments",
        access: "permission",
        permission: USE,
        audit: "ai.attachment.upload",
        rateLimit: { window: 60, max: 30 },
        query: z.object({ name: z.string().max(255).default("file") }),
        handler: async (context) => {
          // A file for the chat, kept for its owner alone. The body is the file itself.
          const userId = ownerOf(context);
          if (!userId) return refuse(403, "FORBIDDEN", "Only a signed-in person can attach files.");
          const mediaType = attachmentType(context.request.headers.get("content-type") ?? "", context.query.name);
          if (!mediaType) return refuse(415, "UNSUPPORTED_FILE", "That kind of file can't be attached. Attach a picture, a PDF, a text file, sound or video.");
          const data = await readLimited(context.request, MAX_ATTACHMENT_BYTES);
          if (!data) return refuse(413, "FILE_TOO_LARGE", `Attach files of up to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
          if (!data.byteLength) return refuse(400, "EMPTY_FILE", "The file is empty.");
          const name = cleanName(context.query.name);
          const id = await attachmentStore(context.store).put(userId, { data, mediaType, name });
          context.auditTarget("ai-attachment", id, { mediaType, bytes: data.byteLength });
          return { id, url: apiPath(`/ext/ai/attachments/${id}`), mediaType, name, bytes: data.byteLength };
        },
      }),
      defineRoute({
        method: "GET",
        path: "/attachments/:id",
        access: "permission",
        permission: USE,
        handler: async (context) => {
          const userId = ownerOf(context);
          const file = userId && ATTACHMENT_ID.test(context.params.id) ? await attachmentStore(context.store).get(userId, context.params.id) : null;
          if (!file) return refuse(404, "NOT_FOUND", "There's no such file.");
          // Only the types it was let in as, never anything a browser would run, and shown inline only when it is a picture, sound or video.
          const kind = ATTACHMENT_TYPES[file.mediaType];
          const type = kind ? file.mediaType : "application/octet-stream";
          const inline = kind === "image" || kind === "audio" || kind === "video";
          return new Response(new Uint8Array(file.data), { headers: {
            "content-type": type,
            "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
            "cache-control": "private, max-age=86400",
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
          } });
        },
      }),
      defineRoute({
        method: "DELETE",
        path: "/attachments/:id",
        access: "permission",
        permission: USE,
        audit: "ai.attachment.delete",
        handler: async (context) => {
          const userId = ownerOf(context);
          if (!userId || !ATTACHMENT_ID.test(context.params.id)) return refuse(404, "NOT_FOUND", "There's no such file.");
          context.auditTarget("ai-attachment", context.params.id);
          await attachmentStore(context.store).remove(userId, context.params.id);
          return { deleted: true };
        },
      }),
      defineRoute({
        method: "GET",
        path: "/roles",
        access: "permission",
        permission: USE,
        handler: async (context) => {
          // For whoever may choose the AI's role: in the chat, or under AI → Settings.
          if (!givesRoles(context.principal) && !context.principal.permissions.has(SETTINGS)) return refuse(403, "FORBIDDEN", "Only someone who may give people roles may choose the AI's role.");
          // Names and labels only. Choosing one can only narrow what the AI does for the person.
          const roles = await context.tools.roles();
          return { options: roles.map((role) => ({ value: role.name, label: role.label, ...(role.description ? { description: role.description } : {}) })) };
        },
      }),
      defineRoute({
        method: "GET",
        path: "/chats",
        access: "permission",
        permission: USE,
        handler: async (context) => {
          const userId = ownerOf(context);
          return { chats: userId ? await chatStore(context.store).list(userId) : [] };
        },
      }),
      defineRoute({
        method: "GET",
        path: "/chats/:id",
        access: "permission",
        permission: USE,
        handler: async (context) => {
          const userId = ownerOf(context);
          const chat = userId && CHAT_ID.test(context.params.id) ? await chatStore(context.store).get(userId, context.params.id) : null;
          return chat ?? refuse(404, "NOT_FOUND", "There's no such chat.");
        },
      }),
      defineRoute({
        method: "DELETE",
        path: "/chats/:id",
        access: "permission",
        permission: USE,
        audit: "ai.chat.delete",
        handler: async (context) => {
          const userId = ownerOf(context);
          if (!userId || !CHAT_ID.test(context.params.id)) return refuse(404, "NOT_FOUND", "There's no such chat.");
          context.auditTarget("ai-chat", context.params.id);
          await chatStore(context.store).remove(userId, context.params.id);
          return { deleted: true };
        },
      }),
      defineRoute({
        method: "POST",
        path: "/fill",
        access: "permission",
        permission: USE,
        audit: "ai.fill",
        rateLimit: { window: 60, max: 20 },
        body: z.object({ collection: z.string().min(1).max(63), prompt: z.string().min(1).max(4000), values: z.record(z.string(), z.unknown()).default({}) }),
        handler: async (context) => {
          const chosen = await modelFor(context, "main");
          if ("refused" in chosen) return chosen.refused;
          const collection = await describe(context, context.body.collection);
          const schema = fillSchema(collection.fields);
          if (!Object.keys(schema.properties).length) return refuse(400, "NOTHING_TO_FILL", "This collection has no fields AI can fill.");
          const current = Object.fromEntries(Object.entries(context.body.values).filter(([name]) => name in schema.properties).map(([name, item]) => [name, textOf(item) || item]));
          context.auditTarget("collection", collection.slug, { model: chosen.modelId });
          try {
            const { output } = await generateText({
              model: chosen.model,
              system: [
                `You fill in a record in the "${collection.name}" collection of a website's CMS. Give a value for each field the request lets you fill well, and leave out fields you'd have to guess. Write rich text as Markdown. Don't invent facts about real people, prices or dates.`,
                chosen.settings.instructions.trim() ? `The site's own guidance:\n${chosen.settings.instructions.trim()}` : "",
                jsonInstructions(schema),
              ].filter(Boolean).join("\n\n"),
              prompt: `Request: ${context.body.prompt}\n\nCurrent values, which the request may ask you to keep or change:\n${JSON.stringify(current).slice(0, 20_000)}`,
              output: Output.object({ schema: jsonSchema(schema as Parameters<typeof jsonSchema>[0]) }),
              maxOutputTokens: chosen.settings.maxOutputTokens,
              abortSignal: context.request.signal,
            });
            return { values: fillValues(collection.fields, output) };
          } catch (error) {
            return providerFailed(error);
          }
        },
      }),
      defineRoute({
        method: "POST",
        path: "/write",
        access: "permission",
        permission: USE,
        audit: "ai.write",
        rateLimit: { window: 60, max: 40 },
        body: z.object({
          collection: z.string().min(1).max(63),
          field: z.string().min(1).max(63),
          action: z.enum(Object.keys(WRITE_ACTIONS) as [WriteAction, ...WriteAction[]]),
          instruction: z.string().max(2000).optional(),
          value: z.unknown().optional(),
          values: z.record(z.string(), z.unknown()).default({}),
        }),
        handler: async (context) => {
          const chosen = await modelFor(context, "fast");
          if ("refused" in chosen) return chosen.refused;
          const collection = await describe(context, context.body.collection);
          const field = collection.fields.find((item) => item.name === context.body.field);
          if (!field || (field.type !== "rich_text" && field.schema?.type !== "string")) return refuse(400, "NOT_WRITABLE", "AI can only write text fields.");
          const value = textOf(context.body.value);
          if (context.body.action !== "write" && !value.trim()) return refuse(400, "EMPTY_FIELD", "There's no text to work on yet. Choose Write instead.");
          const record = Object.fromEntries(Object.entries(context.body.values).map(([name, item]) => [name, textOf(item)]));
          context.auditTarget("collection", collection.slug, { field: field.name, action: context.body.action, model: chosen.modelId });
          try {
            const { text } = await generateText({
              model: chosen.model,
              system: chosen.settings.instructions.trim() ? `The site's own guidance:\n${chosen.settings.instructions.trim()}` : undefined,
              prompt: writePrompt({ action: context.body.action, field, value, instruction: context.body.instruction, record, collection: collection.name }),
              maxOutputTokens: chosen.settings.maxOutputTokens,
              abortSignal: context.request.signal,
            });
            const written = text.trim().replace(/^```(?:markdown|md)?\n([\s\S]*)\n```$/, "$1");
            return { value: field.type === "rich_text" ? fillValues([{ ...field, readonly: false }], { [field.name]: written })[field.name] ?? null : written };
          } catch (error) {
            return providerFailed(error);
          }
        },
      }),
    ],
  });
}
