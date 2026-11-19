import { createXai } from "@ai-sdk/xai";
import { defineAiProvider, fetchModelsJson, guessCapabilities, modalities, openAiModels, str, type ModelChoice } from "@tansy/ai/provider";

/** xAI Grok, through the AI SDK's @ai-sdk/xai. */
export const xai = (options: { defaultModel?: string } = {}) => defineAiProvider({
  id: "xai",
  label: "xAI Grok",
  defaultModel: options.defaultModel ?? "grok-latest",
  // Its settings in other interface languages. English is each setting's own label and description.
  messages: {
    ar: {
      settings: {
        xaiApiKey: {
          label: "مفتاح API لـ xAI Grok",
          description: "من console.x.ai ← API keys."
        }
      }
    }
  },
  settings: () => [
    { name: "xaiApiKey", type: "secret", env: "XAI_API_KEY", label: "xAI Grok API key", description: "From console.x.ai → API keys." },
  ],
  ready: (settings) => Boolean(str(settings.xaiApiKey)),
  model: (settings, modelId) => createXai({ apiKey: str(settings.xaiApiKey) })(modelId),
  imageModel: (settings, modelId) => (guessCapabilities(modelId).output?.includes("image") ? createXai({ apiKey: str(settings.xaiApiKey) }).image(modelId) : undefined),
  // xAI lists its language and image models apart, with what each reads and writes.
  models: async (settings) => {
    const key = str(settings.xaiApiKey);
    const headers = { authorization: `Bearer ${key}` };
    const [language, image] = await Promise.all([
      fetchModelsJson("https://api.x.ai/v1/language-models", { headers }).catch(() => null),
      fetchModelsJson("https://api.x.ai/v1/image-generation-models", { headers }).catch(() => null),
    ]);
    if (!language && !image) return openAiModels("https://api.x.ai/v1", key);
    const read = (json: Record<string, unknown> | null, kind: "text" | "image"): ModelChoice[] => (Array.isArray(json?.models) ? (json.models as Array<Record<string, unknown>>) : [])
      .filter((model) => typeof model.id === "string")
      .map((model) => ({
        value: model.id as string,
        capabilities: { input: modalities(model.input_modalities) ?? ["text"], output: modalities(model.output_modalities) ?? [kind], ...(kind === "text" ? { tools: true, structured: true, reasoning: guessCapabilities(model.id as string).reasoning ?? false } : {}), reported: true },
      }));
    return [...read(language, "text"), ...read(image, "image")].sort((a, b) => a.value.localeCompare(b.value));
  },
});
