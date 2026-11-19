import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { chatImageModel, defineAiProvider, openAiModels, str } from "@tansy/ai/provider";

/** The base address, also when someone pasted the chat endpoint itself, such as https://openrouter.ai/api/v1/chat/completions. */
export const baseUrlOf = (value: unknown) => str(value).replace(/\/+$/, "").replace(/\/(chat\/completions|completions|models)$/, "");

/**
 * Any server that speaks OpenAI's chat API: Ollama, LM Studio, vLLM, OpenRouter, Together,
 * Fireworks, a self-hosted model. Its address is a setting, so only people who may change
 * settings choose where prompts, and the content in them, are sent.
 */
export const openaiCompatible = (options: { defaultModel?: string; baseUrl?: string } = {}) => defineAiProvider({
  id: "compatible",
  label: "OpenAI-compatible server",
  defaultModel: options.defaultModel ?? "",
  // Its settings in other interface languages. English is each setting's own label and description.
  messages: {
    ar: {
      settings: {
        compatibleBaseUrl: {
          label: "عنوان الخادم",
          description: "العنوان الأساسي للـ API، منتهيًا بـ /v1، مثل http://localhost:11434/v1 لـ Ollama أو https://openrouter.ai/api/v1."
        },
        compatibleApiKey: {
          label: "مفتاح API",
          description: "اتركه فارغًا لخادم لا يحتاج مفتاحًا، مثل Ollama على هذا الجهاز."
        }
      }
    }
  },
  settings: () => [
    { name: "compatibleBaseUrl", type: "text", default: options.baseUrl ?? "", maxLength: 500, label: "Server address", description: "The API's base address, ending in /v1, such as http://localhost:11434/v1 for Ollama or https://openrouter.ai/api/v1." },
    { name: "compatibleApiKey", type: "secret", env: "OPENAI_COMPATIBLE_API_KEY", label: "API key", description: "Leave empty for a server that needs none, such as Ollama on this machine." },
  ],
  ready: (settings) => /^https?:\/\/\S+$/.test(str(settings.compatibleBaseUrl)),
  model: (settings, modelId) => createOpenAICompatible({ name: "compatible", baseURL: baseUrlOf(settings.compatibleBaseUrl), apiKey: str(settings.compatibleApiKey) || undefined })(modelId),
  // Servers that draw pictures answer through the chat API with the "image" modality, as OpenRouter does.
  imageModel: (settings, modelId) => chatImageModel({ provider: "compatible", baseUrl: baseUrlOf(settings.compatibleBaseUrl), apiKey: str(settings.compatibleApiKey), modelId }),
  models: (settings) => openAiModels(baseUrlOf(settings.compatibleBaseUrl), str(settings.compatibleApiKey) || undefined),
});
