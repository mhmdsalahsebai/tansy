import { describe, expect, it } from "vitest";
import { assertPluginManifest } from "@/core/extend/manifest";
import { settingsProblem } from "@/core/extend/settings-schema";
import { ai } from "../../plugins/ai/index";
import { chatModels, guessCapabilities, ModelListError, openAiModels } from "../../plugins/ai/provider";
import { baseUrlOf } from "../../plugins/ai-openai-compatible/index";
import { commandcode } from "../../plugins/ai-commandcode/index";
import { opencode } from "../../plugins/ai-opencode/index";
import { providerReason } from "../../plugins/ai/errors";
import { openrouter } from "../../plugins/ai-openrouter/index";

const answering = (status: number, body: unknown, seen: string[] = []) => (async (url: string, init?: RequestInit) => {
  seen.push(`${url} ${new Headers(init?.headers).get("authorization") ?? ""}`);
  return Response.json(body, { status });
}) as unknown as typeof fetch;

describe("listing a provider's models", () => {
  it("reads an OpenAI-style /models with the key, sorted", async () => {
    const seen: string[] = [];
    const models = await openAiModels("https://api.example.test/v1/", "k", { fetcher: answering(200, { data: [{ id: "b" }, { id: "a" }, { nope: 1 }] }, seen) });
    expect(models.map((model) => model.value)).toEqual(["a", "b"]);
    expect(seen).toEqual(["https://api.example.test/v1/models Bearer k"]);
  });

  it("says why it couldn't, in words for the person", async () => {
    await expect(openAiModels("https://x.test", "bad", { fetcher: answering(401, {}) })).rejects.toThrow(ModelListError);
    await expect(openAiModels("https://x.test", "k", { fetcher: answering(200, { data: "no" }) })).rejects.toThrow("wasn't a list");
  });

  it("takes a chat endpoint pasted as a server address", () => {
    expect(baseUrlOf("https://openrouter.ai/api/v1/chat/completions")).toBe("https://openrouter.ai/api/v1");
    expect(baseUrlOf("http://localhost:11434/v1/")).toBe("http://localhost:11434/v1");
  });

  it("lists OpenRouter's free router first, then free models, with what each can do; the chat offers only ones that call tools", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = answering(200, { data: [
      { id: "paid/x", name: "Paid", pricing: { prompt: "0.1", completion: "0.1" }, supported_parameters: ["tools", "structured_outputs"], architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
      { id: "free/y:free", name: "Y (free)", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
      { id: "free/notools:free", name: "No tools", pricing: { prompt: "0", completion: "0" }, supported_parameters: [] },
      { id: "openrouter/free", name: "Free Models Router", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
      { id: "img/draw", name: "Draws", pricing: { prompt: "1", completion: "1" }, supported_parameters: [], architecture: { input_modalities: ["text"], output_modalities: ["image", "text"] } },
    ] });
    try {
      const models = await openrouter().models!({ openrouterApiKey: "k" } as never);
      expect(chatModels(models).map((model) => model.value)).toEqual(["openrouter/free", "free/y:free", "paid/x"]);
      expect(models.find((model) => model.value === "paid/x")?.capabilities).toEqual({ input: ["text", "image"], output: ["text"], tools: true, reasoning: false, structured: true, reported: true });
      expect(models.find((model) => model.value === "img/draw")?.capabilities?.output).toEqual(["image", "text"]);
      expect(models.find((model) => model.value === "free/y:free")?.label).toBe("Y (free)");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("OpenCode", () => {
  it("lists its paid models by name, with what each reads and whether it calls tools; free ones answer only its own app", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = answering(200, { data: [
      { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", modalities: { input: ["text", "image/png", "application/pdf"], output: ["text"] }, capabilities: { tools: { supported: true }, reasoning: { supported: true }, structured_output: true } },
      { id: "plain", name: "Plain", modalities: { input: ["text"], output: ["text"] }, capabilities: { tools: { supported: false } } },
      { id: "big-pickle", name: "Big Pickle", cost: { text: { input: { price: 0 }, output: { price: 0 } } }, capabilities: { tools: { supported: true } } },
      { id: "beam-free", name: "Beam Free", capabilities: { tools: { supported: true } } },
    ] });
    try {
      const models = await opencode().models!({ opencodeApiKey: "k" } as never);
      expect(models.find((model) => model.value === "claude-haiku-5-5")).toEqual({ value: "claude-haiku-5-5", label: "Claude Haiku 5.5", capabilities: { input: ["text", "image", "file"], output: ["text"], tools: true, reasoning: true, structured: true, reported: true } });
      expect(chatModels(models).map((model) => model.value)).toEqual(["claude-haiku-5-5"]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("asks each family through its own API", () => {
    const settings = { opencodeApiKey: "k" } as never;
    const provider = (id: string) => (opencode().model(settings, id) as { provider: string }).provider;
    expect(provider("claude-sonnet-5-5")).toMatch(/^anthropic/);
    expect(provider("gpt-6-luna")).toMatch(/^openai\.responses/);
    expect(provider("gemini-4-argon")).toMatch(/^google/);
    expect(provider("glm-5.3")).toMatch(/^opencode/);
  });
});

describe("why the provider failed", () => {
  const apiError = (statusCode: number, responseBody: string) => Object.assign(new Error("Bad"), { statusCode, responseBody });

  it("says what the provider said, through the SDK's retries", () => {
    const error = { lastError: apiError(429, JSON.stringify({ type: "error", error: { type: "FreeUsageLimitError", message: "Free usage limit reached." } })) };
    expect(providerReason(error)).toBe("The AI provider answered 429: Free usage limit reached.");
  });

  it("names a refused key, and hides anything that looks like one", () => {
    expect(providerReason(apiError(401, JSON.stringify({ error: { message: "Incorrect API key provided: sk-abcdefghijklmnopqrstuvwxyz123456" } })))).toBe("The AI provider refused the key: Incorrect API key provided: …. Check it under AI → Settings.");
  });

  it("falls back to a general message for anything else", () => {
    expect(providerReason(new Error("socket hang up"))).toMatch(/couldn't answer just now/);
  });
});

describe("what a model can do", () => {
  it("guesses from the id when the provider's API only lists ids", () => {
    expect(guessCapabilities("gpt-image-2").output).toEqual(["image"]);
    expect(guessCapabilities("dall-e-3").output).toEqual(["image"]);
    expect(guessCapabilities("gemini-3-flash-image").output).toEqual(["text", "image"]);
    expect(guessCapabilities("o4-mini")).toMatchObject({ output: ["text"], reasoning: true, tools: true, structured: true });
    expect(guessCapabilities("anthropic/claude-sonnet-5-5")).toMatchObject({ input: ["text", "image"], output: ["text"] });
    expect(guessCapabilities("whisper-large-v3").output).toEqual(["audio"]);
    expect(guessCapabilities("my-local-model")).toEqual({ input: ["text"], output: ["text"] });
  });

  it("leaves out speech, embedding and moderation models", async () => {
    const models = await openAiModels("https://x.test/v1", "k", { fetcher: answering(200, { data: [{ id: "gpt-6" }, { id: "text-embedding-3-large" }, { id: "whisper-1" }, { id: "gpt-image-2" }] }) });
    expect(models.map((model) => model.value)).toEqual(["gpt-6", "gpt-image-2"]);
  });
});

describe("suggested setting values", () => {
  it("name the plugin's own GET route and settings that aren't secrets", () => {
    const text = { name: "model", type: "text" as const, default: "", label: "Model" };
    const provider = { name: "provider", type: "text" as const, default: "", label: "Provider" };
    const key = { name: "apiKey", type: "secret" as const, label: "Key" };
    expect(settingsProblem([provider, { ...text, suggestions: { route: "/models", with: ["provider"] } }])).toBeNull();
    expect(settingsProblem([key, { ...text, suggestions: { route: "/models", with: ["apiKey"] } }])).toContain("aren't secrets");
    expect(settingsProblem([{ ...text, suggestions: { route: "models" } }])).toContain("suggestions.route");
    expect(() => assertPluginManifest({ name: "acme", version: "1.0.0", apiVersion: 1, settings: { fields: [{ ...text, suggestions: { route: "/models" } }] } })).toThrow("isn't one of the plugin's GET routes");
  });

  it("are how the AI plugin offers models", () => {
    const plugin = ai({ providers: [openrouter()] });
    expect(() => assertPluginManifest(plugin)).not.toThrow();
    expect(plugin.settings!.fields.find((field) => field.name === "model")).toMatchObject({ suggestions: { route: "/models", with: ["provider"] } });
  });
});

describe("Command Code", () => {
  it("lists the models that chat by name, leaving out those served only elsewhere", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = answering(200, { data: [
      { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", supported_endpoints: ["/messages"] },
      { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", supported_endpoints: ["/chat/completions", "/responses"] },
      { id: "typesafe/jev", name: "Jev", supported_endpoints: ["/systemone"] },
    ] });
    try {
      const models = await commandcode().models!({ commandcodeApiKey: "k" } as never);
      expect(models.map((model) => [model.value, model.label])).toEqual([["claude-haiku-5-5", "Claude Haiku 5.5"], ["deepseek/deepseek-v4-flash", "DeepSeek V4 Flash"]]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("asks Claude through Anthropic's Messages and the rest through OpenAI's chat API", () => {
    const settings = { commandcodeApiKey: "k" } as never;
    const provider = (id: string) => (commandcode().model(settings, id) as { provider: string }).provider;
    expect(provider("claude-sonnet-5-5")).toMatch(/^anthropic/);
    expect(provider("google/gemini-4-argon")).toMatch(/^commandcode/);
    expect(provider("gpt-6-luna")).toMatch(/^commandcode/);
  });
});
