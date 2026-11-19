import { createDeepSeek } from "@ai-sdk/deepseek";
import { defineAiProvider, openAiModels, str } from "@tansy/ai/provider";

/** DeepSeek, through the AI SDK's @ai-sdk/deepseek. */
export const deepseek = (options: { defaultModel?: string } = {}) => defineAiProvider({
  id: "deepseek",
  label: "DeepSeek",
  defaultModel: options.defaultModel ?? "deepseek-v4-pro",
  // Its settings in other interface languages. English is each setting's own label and description.
  messages: {
    ar: {
      settings: {
        deepseekApiKey: {
          label: "مفتاح API لـ DeepSeek",
          description: "من platform.deepseek.com ← API keys."
        }
      }
    }
  },
  settings: () => [
    { name: "deepseekApiKey", type: "secret", env: "DEEPSEEK_API_KEY", label: "DeepSeek API key", description: "From platform.deepseek.com → API keys." },
  ],
  ready: (settings) => Boolean(str(settings.deepseekApiKey)),
  model: (settings, modelId) => createDeepSeek({ apiKey: str(settings.deepseekApiKey) })(modelId),
  models: (settings) => openAiModels("https://api.deepseek.com", str(settings.deepseekApiKey)),
});
