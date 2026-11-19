import type { ImageModel, LanguageModel } from "ai";
import type { Messages, PluginSettingField } from "tansy/plugin";

/**
 * What a model provider adapter implements, such as @tansy/ai-openai. The AI plugin
 * keeps everything providers share: the tools, the prompts, the routes and the dashboard.
 * An adapter only turns its settings into an AI SDK model. See docs/plugins/ai.md.
 */

/** The AI plugin's own settings, and each installed provider's, by name. */
export interface AiSettings {
  /** The id of the provider in use. */
  provider: string;
  /** The model for the assistant. Empty uses the provider's default. */
  model: string;
  /** A cheaper, quicker model for writing one field. Empty uses `model`. */
  fastModel: string;
  /** Whether people choose the model and thinking in the chat. */
  chooseModel: boolean;
  /** How long the assistant thinks by default: "provider-default", "none", "low", "medium" or "high". */
  reasoning: string;
  /** The role the AI acts with, by name. Empty uses ai-assistant. */
  role?: string;
  /** Whether people choose that role in the chat. */
  chooseRole?: boolean;
  /** The provider that draws pictures in the chat. "same" uses `provider`. */
  imageProvider?: string;
  /** The model that draws pictures in the chat. Empty means the chat doesn't draw. */
  imageModel?: string;
  /** The site's own guidance, added to every prompt: tone, audience, house style. */
  instructions: string;
  maxSteps: number;
  maxOutputTokens: number;
  [name: string]: unknown;
}

export interface AiProvider {
  /** Lowercase letters and digits, such as "openai". Every setting's name starts with it. */
  id: string;
  label: string;
  /** The model used when the settings name none. */
  defaultModel: string;
  /** Its keys and options under AI → Settings. */
  settings(): PluginSettingField[];
  /**
   * Its settings' words in other interface languages, by language code, as
   * `{ ar: { settings: { <name>: { label, description } } } }`. AI adds them to its own
   * `messages`, and the setting's `label` and `description` cover any language missing.
   */
  messages?: Record<string, Messages>;
  /** Whether what it needs is set. */
  ready(settings: AiSettings): boolean;
  /** The AI SDK model for an id, such as "gpt-6-astra". */
  model(settings: AiSettings, modelId: string): LanguageModel;
  /**
   * The AI SDK image model for an id, such as "gpt-image-2", for workflows that draw
   * pictures. Undefined for an id that isn't one: a language model that answers with images,
   * such as Gemini's, is then asked through `model`.
   */
  imageModel?(settings: AiSettings, modelId: string): ImageModel | undefined;
  /**
   * The provider's icon from @lobehub/icons, such as "openai" or "claude". The dashboard
   * knows the icons of the providers Tansy ships, so only another adapter needs it.
   */
  icon?: string;
  /**
   * The models its key can use, for the model settings to offer. Throws a ModelListError
   * with a message for the person when they can't be listed. Without it, people type the id.
   */
  models?(settings: AiSettings): Promise<ModelChoice[]>;
}

/** What a model reads or writes. */
export type Modality = "text" | "image" | "audio" | "video" | "file";

/**
 * What a model can do, as its provider's API says, or as its id suggests when the API says
 * nothing. A missing field is unknown, which workflows allow with a warning.
 */
export interface ModelCapabilities {
  input?: Modality[];
  output?: Modality[];
  /** Calls tools, which the assistant needs. */
  tools?: boolean;
  /** Thinks before it answers. */
  reasoning?: boolean;
  /** Answers in a JSON shape it's given, which workflows need to write records. */
  structured?: boolean;
  /** Read from the provider's API, rather than guessed from the id. */
  reported?: boolean;
}

export interface ModelChoice { value: string; label?: string; capabilities?: ModelCapabilities }

/** Why a provider's models couldn't be listed, in words for the person choosing one. */
export class ModelListError extends Error {}

/**
 * The models an OpenAI-style API lists at `<baseUrl>/models`, as OpenAI, OpenRouter, Groq,
 * Mistral, xAI, DeepSeek, Ollama, LM Studio and vLLM do. `label` names a model from what
 * the API says about it, such as OpenRouter's name and price.
 */
export async function openAiModels(baseUrl: string, apiKey: string | undefined, options: { label?: (model: Record<string, unknown>) => string | undefined; capabilities?: (model: Record<string, unknown>) => ModelCapabilities | undefined; fetcher?: typeof fetch } = {}): Promise<ModelChoice[]> {
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(`${baseUrl.replace(/\/+$/, "")}/models`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new ModelListError("The provider couldn't be reached.");
  }
  if (response.status === 401 || response.status === 403) throw new ModelListError("The provider refused the key. Check it, and save it first.");
  if (!response.ok) throw new ModelListError(`The provider answered ${response.status}.`);
  const json = (await response.json().catch(() => null)) as { data?: unknown } | null;
  if (!Array.isArray(json?.data)) throw new ModelListError("The provider's answer wasn't a list of models.");
  return json.data
    .filter((model): model is Record<string, unknown> => Boolean(model) && typeof (model as { id?: unknown }).id === "string")
    .map((model) => ({ value: model.id as string, label: options.label?.(model), capabilities: options.capabilities ? options.capabilities(model) : guessCapabilities(model.id as string) }))
    .filter((model) => !isUnusable(model.capabilities))
    .sort((a, b) => a.value.localeCompare(b.value));
}

/** Fetches a provider's JSON with a timeout, throwing a ModelListError in words for the person. */
export async function fetchModelsJson(url: string, init: RequestInit = {}, fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new ModelListError("The provider couldn't be reached.");
  }
  if (response.status === 400 || response.status === 401 || response.status === 403) throw new ModelListError("The provider refused the key. Check it, and save it first.");
  if (!response.ok) throw new ModelListError(`The provider answered ${response.status}.`);
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!json || typeof json !== "object") throw new ModelListError("The provider's answer wasn't a list of models.");
  return json;
}

/**
 * What a model can do, from its id alone, for providers whose API lists only ids. Families
 * that draw pictures, read images or think are known by name; anything else is a text model
 * whose tools and structured answers are unknown.
 */
export function guessCapabilities(id: string): ModelCapabilities {
  const name = id.toLowerCase().split("/").pop() ?? "";
  if (/(^|[-_])(whisper|tts|transcribe|embed|embedding|moderation|rerank|guard|realtime|audio|search-preview|computer-use)([-_.:]|$)/.test(name) || /^(text-embedding|omni-moderation|babbage|davinci|distil-whisper)/.test(name)) return { input: ["audio"], output: ["audio"] };
  if (/^(gpt-image|dall-e|imagen|flux|stable-diffusion|sd3|sdxl|ideogram|recraft|seedream|grok-\d+(\.\d+)?-image|grok-2-image|grok-imagine-image)/.test(name) || /(^|-)image-(gen|generation)/.test(name)) return { input: ["text"], output: ["image"] };
  const imageOut = /gemini-[\w.-]*image|nano-banana/.test(name);
  const vision = /^(gpt-4o|gpt-4\.1|gpt-[5-9]|o[1-9]|claude|gemini|gemma-3|grok-[2-9]|pixtral|mistral-(medium|large|small)-(2|3|latest)|llama-4|qwen[\w.-]*vl|llava|kimi)/.test(name) || /vision|-vl\b/.test(name);
  const reasoning = /^(o[1-9]|gpt-[5-9]|claude-(opus|sonnet)-[4-9]|claude-[3-9]-7|gemini-(2\.5|[3-9])|grok-[3-9]|deepseek-r|qwq|magistral|kimi-k2-thinking)/.test(name) || /reason|think/.test(name);
  return {
    input: vision ? ["text", "image"] : ["text"],
    output: imageOut ? ["text", "image"] : ["text"],
    ...(reasoning ? { reasoning: true } : {}),
    ...(/^(gpt-[4-9]|o[1-9]|claude|gemini|grok|mistral|magistral|codestral|deepseek|llama-3\.[1-9]|llama-4|qwen|kimi)/.test(name) ? { tools: true, structured: true } : {}),
  };
}

/** Speech, embeddings and moderation: models nothing in the CMS can use. */
const isUnusable = (capabilities: ModelCapabilities | undefined) => Boolean(capabilities?.output?.length) && !capabilities!.output!.includes("text") && !capabilities!.output!.includes("image");

/** Models the assistant can chat with: those that answer in text and, as far as is known, call tools. */
export const chatModels = (models: ModelChoice[]) => models.filter((model) => {
  const output = model.capabilities?.output;
  return (!output || output.includes("text")) && model.capabilities?.tools !== false;
});

/** Models that draw: image models, and language models that answer with pictures. */
export const imageModels = (models: ModelChoice[]) => models.filter((model) => model.capabilities?.output?.includes("image"));

/** Modalities as an API writes them, such as OpenRouter's ["text", "image"]. */
export const modalities = (value: unknown): Modality[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const known = new Set<Modality>(["text", "image", "audio", "video", "file"]);
  return value.filter((item): item is Modality => typeof item === "string" && known.has(item as Modality));
};

/**
 * An image model for an OpenAI-style chat API that answers with pictures when asked for the
 * "image" modality, as OpenRouter does for Gemini, GPT and FLUX image models. The pictures
 * come back as data URLs on the message.
 */
export function chatImageModel(options: { provider: string; baseUrl: string; apiKey: string; modelId: string; headers?: Record<string, string>; fetcher?: typeof fetch }): ImageModel {
  const fetcher = options.fetcher ?? fetch;
  return {
    specificationVersion: "v4",
    provider: options.provider,
    modelId: options.modelId,
    maxImagesPerCall: 1,
    async doGenerate({ prompt, aspectRatio, abortSignal }) {
      const response = await fetcher(`${options.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}`, ...options.headers },
        body: JSON.stringify({ model: options.modelId, modalities: ["image", "text"], messages: [{ role: "user", content: prompt ?? "" }], ...(aspectRatio ? { image_config: { aspect_ratio: aspectRatio } } : {}) }),
        signal: abortSignal,
      });
      if (!response.ok) throw Object.assign(new Error(`The provider answered ${response.status}.`), { statusCode: response.status, isRetryable: response.status === 429 || response.status >= 500 });
      const json = (await response.json()) as { choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: string } }> } }> };
      const images = (json.choices?.[0]?.message?.images ?? []).map((image) => image.image_url?.url ?? "").filter((url) => url.startsWith("data:")).map((url) => url.slice(url.indexOf(",") + 1));
      if (!images.length) throw new Error("The model answered without a picture.");
      return { images, warnings: [], response: { timestamp: new Date(), modelId: options.modelId, headers: undefined } };
    },
  } as ImageModel;
}

/** Types an adapter. */
export const defineAiProvider = (provider: AiProvider): AiProvider => provider;

export const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");
