import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { chatImageModel, defineAiProvider, modalities, openAiModels, str } from "@tansy/ai/provider";

const BASE_URL = "https://openrouter.ai/api/v1";

/**
 * OpenRouter, through its OpenAI-compatible API. Models are named `vendor/model`, such as
 * `anthropic/claude-sonnet-5-5`. The default, `openrouter/free`, routes each request to a
 * free model that supports tool calls, so the assistant works with no credit on the account.
 */
export const openrouter = (options: { defaultModel?: string; appName?: string } = {}) => defineAiProvider({
  id: "openrouter",
  label: "OpenRouter",
  defaultModel: options.defaultModel ?? "openrouter/free",
  // Its settings in other interface languages. English is each setting's own label and description.
  messages: {
    ar: {
      settings: {
        openrouterApiKey: {
          label: "مفتاح API لـ OpenRouter",
          description: "من openrouter.ai ← Keys."
        }
      }
    }
  },
  settings: () => [
    { name: "openrouterApiKey", type: "secret", env: "OPENROUTER_API_KEY", label: "OpenRouter API key", description: "From openrouter.ai → Keys." },
  ],
  ready: (settings) => Boolean(str(settings.openrouterApiKey)),
  model: (settings, modelId) => createOpenAICompatible({
    name: "openrouter",
    baseURL: BASE_URL,
    apiKey: str(settings.openrouterApiKey),
    // How OpenRouter names the app in its usage pages.
    headers: { "X-Title": options.appName ?? "tansy" },
  })(modelId),
  // Models that draw pictures answer through the chat API with the "image" modality.
  imageModel: (settings, modelId) => chatImageModel({ provider: "openrouter", baseUrl: BASE_URL, apiKey: str(settings.openrouterApiKey), modelId, headers: { "X-Title": options.appName ?? "tansy" } }),
  // Free models first. What each reads and writes, and whether it calls tools, as OpenRouter reports it.
  models: async (settings) => {
    const free = (model: Record<string, unknown>) => {
      const pricing = model.pricing as { prompt?: string; completion?: string } | undefined;
      return Number(pricing?.prompt) === 0 && Number(pricing?.completion) === 0;
    };
    const seen = new Map<string, Record<string, unknown>>();
    const models = await openAiModels(BASE_URL, str(settings.openrouterApiKey) || undefined, {
      label: (model) => {
        seen.set(model.id as string, model);
        const name = String(model.name ?? model.id);
        return free(model) && !/\bfree\b/i.test(name) ? `${name} (free)` : name;
      },
      capabilities: (model) => {
        const architecture = (model.architecture ?? {}) as { input_modalities?: unknown; output_modalities?: unknown };
        const parameters = Array.isArray(model.supported_parameters) ? (model.supported_parameters as string[]) : null;
        return {
          input: modalities(architecture.input_modalities),
          output: modalities(architecture.output_modalities),
          ...(parameters ? { tools: parameters.includes("tools"), reasoning: parameters.includes("reasoning"), structured: parameters.includes("structured_outputs") || parameters.includes("response_format") } : {}),
          reported: true,
        };
      },
    });
    // OpenRouter's own router of free models, the default, leads.
    const rank = (model: { value: string }) => (model.value === "openrouter/free" ? 0 : free(seen.get(model.value)!) ? 1 : 2);
    return models.sort((a, b) => rank(a) - rank(b));
  },
});
