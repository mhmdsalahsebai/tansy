import { createGroq } from "@ai-sdk/groq";
import { defineAiProvider, openAiModels, str } from "@tansy/ai/provider";

/** Groq, through the AI SDK's @ai-sdk/groq. */
export const groq = (options: { defaultModel?: string } = {}) => defineAiProvider({
  id: "groq",
  label: "Groq",
  defaultModel: options.defaultModel ?? "openai/gpt-oss-120b",
  // Its settings in other interface languages. English is each setting's own label and description.
  messages: {
    ar: {
      settings: {
        groqApiKey: {
          label: "مفتاح API لـ Groq",
          description: "من console.groq.com ← API keys."
        }
      }
    }
  },
  settings: () => [
    { name: "groqApiKey", type: "secret", env: "GROQ_API_KEY", label: "Groq API key", description: "From console.groq.com → API keys." },
  ],
  ready: (settings) => Boolean(str(settings.groqApiKey)),
  model: (settings, modelId) => createGroq({ apiKey: str(settings.groqApiKey) })(modelId),
  models: (settings) => openAiModels("https://api.groq.com/openai/v1", str(settings.groqApiKey)),
});
