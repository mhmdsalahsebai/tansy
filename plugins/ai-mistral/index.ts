import { createMistral } from "@ai-sdk/mistral";
import { defineAiProvider, guessCapabilities, openAiModels, str } from "@tansy/ai/provider";

/** Mistral, through the AI SDK's @ai-sdk/mistral. */
export const mistral = (options: { defaultModel?: string } = {}) => defineAiProvider({
  id: "mistral",
  label: "Mistral",
  defaultModel: options.defaultModel ?? "mistral-large-latest",
  // Its settings in other interface languages. English is each setting's own label and description.
  messages: {
    ar: {
      settings: {
        mistralApiKey: {
          label: "مفتاح API لـ Mistral",
          description: "من console.mistral.ai ← API keys."
        }
      }
    }
  },
  settings: () => [
    { name: "mistralApiKey", type: "secret", env: "MISTRAL_API_KEY", label: "Mistral API key", description: "From console.mistral.ai → API keys." },
  ],
  ready: (settings) => Boolean(str(settings.mistralApiKey)),
  model: (settings, modelId) => createMistral({ apiKey: str(settings.mistralApiKey) })(modelId),
  // Mistral says what each model can do: chat, call functions, read images.
  models: (settings) => openAiModels("https://api.mistral.ai/v1", str(settings.mistralApiKey), {
    capabilities: (model) => {
      const can = model.capabilities as { completion_chat?: boolean; function_calling?: boolean; vision?: boolean } | undefined;
      if (!can) return guessCapabilities(model.id as string);
      if (!can.completion_chat) return { input: ["text"], output: ["audio"], reported: true };
      return { input: can.vision ? ["text", "image"] : ["text"], output: ["text"], tools: Boolean(can.function_calling), structured: true, reasoning: /magistral/.test(model.id as string), reported: true };
    },
  }),
});
