import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAiProvider, openAiModels, str } from "@tansy/ai/provider";

const BASE_URL = "https://api.commandcode.ai/provider/v1";

/** The routes Command Code serves a model on, from its model list. */
const endpointsOf = (model: Record<string, unknown>) =>
  Array.isArray(model.supported_endpoints) ? model.supported_endpoints.filter((item): item is string => typeof item === "string") : null;

/**
 * Command Code's provider API (commandcode.ai/docs/provider), with one key. Claude is asked
 * only through Anthropic's Messages, as Command Code serves it nowhere else; GPT, Gemini,
 * Grok and the open models (DeepSeek, Kimi, GLM, Qwen, MiniMax…) through OpenAI's chat API,
 * which every one of them answers on.
 */
export const commandcode = (options: { defaultModel?: string } = {}) => defineAiProvider({
  id: "commandcode",
  label: "Command Code",
  icon: "commandcode",
  defaultModel: options.defaultModel ?? "claude-haiku-5-5",
  // Its settings in other interface languages. English is each setting's own label and description.
  messages: {
    ar: {
      settings: {
        commandcodeApiKey: {
          label: "مفتاح API لـ Command Code",
          description: "من commandcode.ai/settings/keys. تحتاج خطة غير Go."
        }
      }
    }
  },
  settings: () => [
    { name: "commandcodeApiKey", type: "secret", env: "COMMANDCODE_API_KEY", label: "Command Code API key", description: "From commandcode.ai/settings/keys. Any plan but Go." },
  ],
  ready: (settings) => Boolean(str(settings.commandcodeApiKey)),
  model: (settings, modelId) => {
    const apiKey = str(settings.commandcodeApiKey);
    if (/^claude-/.test(modelId)) return createAnthropic({ baseURL: BASE_URL, apiKey })(modelId);
    return createOpenAICompatible({ name: "commandcode", baseURL: BASE_URL, apiKey, includeUsage: true })(modelId);
  },
  // Its list names each model and the routes it's served on, but not what it reads or calls,
  // so that comes from its name. Models served only elsewhere, such as the decision models on
  // /systemone, can't chat and are left out.
  models: async (settings) => {
    const skipped = new Set<string>();
    const models = await openAiModels(BASE_URL, str(settings.commandcodeApiKey) || undefined, {
      label: (model) => {
        const endpoints = endpointsOf(model);
        if (endpoints && !endpoints.includes("/messages") && !endpoints.includes("/chat/completions")) skipped.add(model.id as string);
        return typeof model.name === "string" ? model.name : undefined;
      },
    });
    return models.filter((model) => !skipped.has(model.value));
  },
});
