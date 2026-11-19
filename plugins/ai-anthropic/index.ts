import { createAnthropic } from "@ai-sdk/anthropic";
import { defineAiProvider, fetchModelsJson, guessCapabilities, str } from "@tansy/ai/provider";

/** Anthropic, through the AI SDK's @ai-sdk/anthropic. */
export const anthropic = (options: { defaultModel?: string } = {}) => defineAiProvider({
  id: "anthropic",
  label: "Anthropic",
  defaultModel: options.defaultModel ?? "claude-sonnet-5-5",
  // Its settings in other interface languages. English is each setting's own label and description.
  messages: {
    ar: {
      settings: {
        anthropicApiKey: {
          label: "مفتاح API لـ Anthropic",
          description: "من console.anthropic.com ← API keys."
        }
      }
    }
  },
  settings: () => [
    { name: "anthropicApiKey", type: "secret", env: "ANTHROPIC_API_KEY", label: "Anthropic API key", description: "From console.anthropic.com → API keys." },
  ],
  ready: (settings) => Boolean(str(settings.anthropicApiKey)),
  model: (settings, modelId) => createAnthropic({ apiKey: str(settings.anthropicApiKey) })(modelId),
  // Every Claude model reads text and images, calls tools and answers in a given shape.
  models: async (settings) => {
    const json = await fetchModelsJson("https://api.anthropic.com/v1/models?limit=1000", { headers: { "x-api-key": str(settings.anthropicApiKey), "anthropic-version": "2023-06-01" } });
    return (Array.isArray(json.data) ? (json.data as Array<Record<string, unknown>>) : [])
      .filter((model) => typeof model.id === "string")
      .map((model) => ({
        value: model.id as string,
        label: typeof model.display_name === "string" ? model.display_name : undefined,
        capabilities: { input: ["text", "image", "file"], output: ["text"], tools: true, structured: true, reasoning: guessCapabilities(model.id as string).reasoning ?? false, reported: true },
      }));
  },
});
