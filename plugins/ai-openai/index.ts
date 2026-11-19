import { createOpenAI } from "@ai-sdk/openai";
import { defineAiProvider, guessCapabilities, openAiModels, str } from "@tansy/ai/provider";

/** OpenAI, through the AI SDK's @ai-sdk/openai. */
export const openai = (options: { defaultModel?: string } = {}) => defineAiProvider({
  id: "openai",
  label: "OpenAI",
  defaultModel: options.defaultModel ?? "gpt-6-astra",
  // Its settings in other interface languages. English is each setting's own label and description.
  messages: {
    ar: {
      settings: {
        openaiApiKey: {
          label: "مفتاح API لـ OpenAI",
          description: "من platform.openai.com ← API keys."
        }
      }
    }
  },
  settings: () => [
    { name: "openaiApiKey", type: "secret", env: "OPENAI_API_KEY", label: "OpenAI API key", description: "From platform.openai.com → API keys." },
  ],
  ready: (settings) => Boolean(str(settings.openaiApiKey)),
  model: (settings, modelId) => createOpenAI({ apiKey: str(settings.openaiApiKey) })(modelId),
  // GPT Image and DALL·E draw pictures. OpenAI's /models lists ids only, so what each can do comes from its name.
  imageModel: (settings, modelId) => (guessCapabilities(modelId).output?.includes("image") ? createOpenAI({ apiKey: str(settings.openaiApiKey) }).image(modelId) : undefined),
  models: (settings) => openAiModels("https://api.openai.com/v1", str(settings.openaiApiKey)),
});
