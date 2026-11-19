import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAiProvider, openAiModels, str, type Modality } from "@tansy/ai/provider";

const BASE_URL = "https://opencode.ai/inference";

/** Media types as OpenCode lists them, such as "image/png" or "application/pdf", as modalities. */
const modalitiesOf = (value: unknown): Modality[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const found = new Set<Modality>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const kind = item.split("/")[0];
    if (kind === "text" || kind === "image" || kind === "audio" || kind === "video") found.add(kind);
    else if (kind === "application") found.add("file");
  }
  return [...found];
};

/** A model OpenCode prices at nothing, which only its own app may use. */
const isFree = (model: Record<string, unknown>) => {
  const text = ((model.cost ?? {}) as { text?: { input?: { price?: unknown }; output?: { price?: unknown } } }).text;
  return /-free$/.test(String(model.id)) || (text?.input?.price === 0 && text?.output?.price === 0);
};

/**
 * OpenCode's pay-as-you-go models (opencode.ai/console), with one key. Each family is asked
 * through its own API, as OpenCode's model list names it: Claude through Anthropic's
 * Messages, GPT, Grok and Muse through OpenAI's Responses, Gemini through Google's, and the
 * open models (GLM, Kimi, Qwen, DeepSeek, MiniMax…) through OpenAI's chat API, which
 * OpenCode also translates for any text model.
 */
export const opencode = (options: { defaultModel?: string } = {}) => defineAiProvider({
  id: "opencode",
  label: "OpenCode",
  icon: "opencode",
  defaultModel: options.defaultModel ?? "claude-haiku-5-5",
  // Its settings in other interface languages. English is each setting's own label and description.
  messages: {
    ar: {
      settings: {
        opencodeApiKey: {
          label: "مفتاح API لـ OpenCode",
          description: "من opencode.ai/console ← API keys."
        }
      }
    }
  },
  settings: () => [
    { name: "opencodeApiKey", type: "secret", env: "OPENCODE_API_KEY", label: "OpenCode API key", description: "From opencode.ai/console → API keys." },
  ],
  ready: (settings) => Boolean(str(settings.opencodeApiKey)),
  model: (settings, modelId) => {
    const apiKey = str(settings.opencodeApiKey);
    if (/^claude-/.test(modelId)) return createAnthropic({ baseURL: `${BASE_URL}/anthropic/v1`, apiKey })(modelId);
    if (/^(gpt-|grok-|muse-)/.test(modelId)) return createOpenAI({ baseURL: `${BASE_URL}/openai/v1`, apiKey }).responses(modelId);
    if (/^gemini-/.test(modelId)) return createGoogleGenerativeAI({ baseURL: `${BASE_URL}/google/v1beta`, apiKey })(modelId);
    return createOpenAICompatible({ name: "opencode", baseURL: `${BASE_URL}/openai/v1`, apiKey })(modelId);
  },
  // What each reads and writes, and whether it calls tools, as OpenCode's model list reports it.
  // Its free models answer only the OpenCode app itself, so they're left out.
  models: async (settings) => {
    const free = new Set<string>();
    const models = await openAiModels(`${BASE_URL}/v1`, str(settings.opencodeApiKey) || undefined, {
      label: (model) => {
        if (isFree(model)) free.add(model.id as string);
        return typeof model.name === "string" ? model.name : undefined;
      },
      capabilities: (model) => {
        const capabilities = (model.capabilities ?? {}) as { tools?: { supported?: unknown }; reasoning?: { supported?: unknown }; structured_output?: unknown };
        const io = (model.modalities ?? {}) as { input?: unknown; output?: unknown };
        return {
          input: modalitiesOf(io.input),
          output: modalitiesOf(io.output),
          tools: capabilities.tools?.supported === true,
          reasoning: capabilities.reasoning?.supported === true,
          structured: capabilities.structured_output === true,
          reported: true,
        };
      },
    });
    return models.filter((model) => !free.has(model.value));
  },
});
