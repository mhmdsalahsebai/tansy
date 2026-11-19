import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { defineAiProvider, fetchModelsJson, guessCapabilities, str, type ModelCapabilities } from "@tansy/ai/provider";

/** Google Gemini, through the AI SDK's @ai-sdk/google. */
export const google = (options: { defaultModel?: string } = {}) => defineAiProvider({
  id: "google",
  label: "Google Gemini",
  defaultModel: options.defaultModel ?? "gemini-pro-latest",
  // Its settings in other interface languages. English is each setting's own label and description.
  messages: {
    ar: {
      settings: {
        googleApiKey: {
          label: "مفتاح API لـ Google Gemini",
          description: "من aistudio.google.com ← Get API key."
        }
      }
    }
  },
  settings: () => [
    { name: "googleApiKey", type: "secret", env: "GOOGLE_GENERATIVE_AI_API_KEY", label: "Google Gemini API key", description: "From aistudio.google.com → Get API key." },
  ],
  ready: (settings) => Boolean(str(settings.googleApiKey)),
  model: (settings, modelId) => createGoogleGenerativeAI({ apiKey: str(settings.googleApiKey) })(modelId),
  // Imagen draws pictures through its own API. Gemini's image models answer in the chat, through `model`.
  imageModel: (settings, modelId) => (/^imagen/.test(modelId) ? createGoogleGenerativeAI({ apiKey: str(settings.googleApiKey) }).image(modelId) : undefined),
  // Google lists what each model's API can be called with: generateContent for Gemini, predict for Imagen.
  models: async (settings) => {
    const json = await fetchModelsJson("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", { headers: { "x-goog-api-key": str(settings.googleApiKey) } });
    return (Array.isArray(json.models) ? (json.models as Array<Record<string, unknown>>) : [])
      .filter((model) => typeof model.name === "string")
      .flatMap((model) => {
        const id = (model.name as string).replace(/^models\//, "");
        const methods = Array.isArray(model.supportedGenerationMethods) ? (model.supportedGenerationMethods as string[]) : [];
        const guess = guessCapabilities(id);
        let capabilities: ModelCapabilities;
        if (/^imagen/.test(id)) capabilities = { input: ["text"], output: ["image"], reported: true };
        else if (methods.includes("generateContent")) capabilities = { input: ["text", "image", "audio", "video", "file"], output: guess.output ?? ["text"], tools: !/image|tts|embedding/.test(id), structured: !/image|tts/.test(id), reasoning: Boolean(model.thinking) || (guess.reasoning ?? false), reported: true };
        else return [];
        return [{ value: id, label: typeof model.displayName === "string" ? model.displayName : undefined, capabilities }];
      })
      .sort((a, b) => a.value.localeCompare(b.value));
  },
});
