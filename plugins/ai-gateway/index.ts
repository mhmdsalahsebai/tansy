import { createGateway } from "@ai-sdk/gateway";
import { defineAiProvider, fetchModelsJson, guessCapabilities, str, type Modality } from "@tansy/ai/provider";

/** Vercel AI Gateway, through the AI SDK's @ai-sdk/gateway. */
export const gateway = (options: { defaultModel?: string } = {}) => defineAiProvider({
  id: "gateway",
  label: "Vercel AI Gateway",
  defaultModel: options.defaultModel ?? "anthropic/claude-sonnet-5.5",
  // Its settings in other interface languages. English is each setting's own label and description.
  messages: {
    ar: {
      settings: {
        gatewayApiKey: {
          label: "مفتاح API لـ Vercel AI Gateway",
          description: "نماذج من كل مزوّد كبير بمفتاح واحد، بصيغة provider/model، مثل openai/gpt-6-astra. من vercel.com ← AI Gateway ← API keys."
        }
      }
    }
  },
  settings: () => [
    { name: "gatewayApiKey", type: "secret", env: "AI_GATEWAY_API_KEY", label: "Vercel AI Gateway API key", description: "Models from every major provider with one key, as provider/model, such as openai/gpt-6-astra. From vercel.com → AI Gateway → API keys." },
  ],
  ready: (settings) => Boolean(str(settings.gatewayApiKey)),
  model: (settings, modelId) => createGateway({ apiKey: str(settings.gatewayApiKey) })(modelId),
  imageModel: (settings, modelId) => (guessCapabilities(modelId).output?.includes("image") && !/gemini/.test(modelId) ? createGateway({ apiKey: str(settings.gatewayApiKey) }).imageModel(modelId) : undefined),
  // The gateway says each model's kind and tags: tool-use, reasoning, vision, image-generation.
  models: async (settings) => {
    const json = await fetchModelsJson("https://ai-gateway.vercel.sh/v1/models", { headers: { authorization: `Bearer ${str(settings.gatewayApiKey)}` } });
    return (Array.isArray(json.data) ? (json.data as Array<Record<string, unknown>>) : [])
      .filter((model) => typeof model.id === "string" && (model.type === "language" || model.type === "image" || model.type === undefined))
      .map((model) => {
        const tags = Array.isArray(model.tags) ? (model.tags as string[]) : [];
        const image = model.type === "image";
        const input: Modality[] = ["text", ...(tags.includes("vision") ? ["image" as const] : []), ...(tags.includes("file-input") ? ["file" as const] : [])];
        return {
          value: model.id as string,
          label: typeof model.name === "string" ? model.name : undefined,
          capabilities: image
            ? { input: ["text" as const], output: ["image" as const], reported: true }
            : { input, output: tags.includes("image-generation") ? ["text" as const, "image" as const] : ["text" as const], tools: tags.includes("tool-use"), reasoning: tags.includes("reasoning"), structured: tags.includes("tool-use"), reported: true },
        };
      })
      .sort((a, b) => a.value.localeCompare(b.value));
  },
});
