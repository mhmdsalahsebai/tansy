"use client";

import { ICONS } from "../icons.generated";

/** The icon of each provider Tansy ships an adapter for. Others name theirs with `icon`. */
const PROVIDERS: Record<string, string> = {
  openai: "openai",
  anthropic: "claude",
  google: "gemini",
  gateway: "vercel",
  mistral: "mistral",
  xai: "xai",
  groq: "groq",
  deepseek: "deepseek",
  openrouter: "openrouter",
  opencode: "opencode",
  commandcode: "commandcode",
  compatible: "ollama",
};

/** A model id's vendor, as routers write it: "anthropic/claude-…", "meta-llama/llama-…". */
const VENDORS: Record<string, string> = {
  openai: "openai", anthropic: "claude", google: "gemini", "meta-llama": "meta", meta: "meta", mistralai: "mistral", mistral: "mistral",
  "x-ai": "grok", xai: "grok", deepseek: "deepseek", "deepseek-ai": "deepseek", qwen: "qwen", alibaba: "qwen", moonshotai: "kimi",
  "z-ai": "zhipu", zai: "zhipu", thudm: "zhipu", cohere: "cohere", microsoft: "microsoft", nvidia: "nvidia", perplexity: "perplexity",
  "black-forest-labs": "flux", bfl: "flux", stabilityai: "stability", amazon: "nova", minimax: "minimax", ai21: "ai21",
  "nousresearch": "nousresearch", liquid: "liquid", bytedance: "doubao", inflection: "inflection", recraft: "recraft", ideogram: "ideogram",
};

/** Model families by name, checked in order. */
const FAMILIES: Array<[RegExp, string]> = [
  [/dall-e/, "dalle"], [/sora/, "sora"], [/^(gpt|o\d|chatgpt|codex|text-|davinci|babbage|omni)/, "openai"],
  [/claude/, "claude"], [/gemma/, "gemma"], [/gemini|nano-banana|learnlm/, "gemini"], [/imagen|veo|palm/, "google"],
  [/mistral|mixtral|codestral|magistral|pixtral|ministral|devstral|voxtral/, "mistral"], [/grok/, "grok"], [/deepseek/, "deepseek"],
  [/llama/, "meta"], [/qwen|qwq/, "qwen"], [/kimi|moonshot/, "kimi"], [/glm|chatglm/, "zhipu"], [/minimax|abab/, "minimax"],
  [/command|aya/, "cohere"], [/^phi-|wizardlm/, "microsoft"], [/nemotron/, "nvidia"], [/sonar|pplx/, "perplexity"],
  [/flux/, "flux"], [/stable-diffusion|sdxl|sd3/, "stability"], [/ideogram/, "ideogram"], [/recraft/, "recraft"],
  [/nova|titan/, "nova"], [/jamba/, "ai21"], [/^yi-/, "yi"], [/hunyuan/, "hunyuan"], [/doubao|seed/, "doubao"], [/^step-/, "stepfun"],
  [/internlm/, "internlm"], [/lfm/, "liquid"], [/hermes/, "nousresearch"], [/ernie/, "wenxin"],
];

/** The icon for a model: its family by name, else its vendor, else none. */
export function modelIconKey(id: string): string | null {
  const [vendor, ...rest] = id.toLowerCase().split("/");
  const name = rest.length ? rest.join("/") : vendor;
  for (const [pattern, key] of FAMILIES) if (pattern.test(name)) return key;
  return rest.length && VENDORS[vendor] ? VENDORS[vendor] : null;
}

export const providerIconKey = (provider: string, icon?: string) => icon ?? PROVIDERS[provider] ?? null;

const dataUri = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/**
 * An icon from @lobehub/icons by name. One-colour icons follow the text colour through a
 * mask, so they read in dark mode; colour icons are drawn as they are.
 */
export function BrandIcon({ name, size = 18, fallback, title }: { name: string | null; size?: number; fallback?: string; title?: string }) {
  const icon = name ? ICONS[name] : undefined;
  const style = { width: size, height: size } as const;
  if (!icon) return <span className="wf-brand wf-brand-letter" style={{ ...style, fontSize: size * 0.55 }} title={title} aria-hidden={!title}>{(fallback ?? "?").slice(0, 1).toUpperCase()}</span>;
  const uri = dataUri(icon.svg);
  if (icon.mono) return <span className="wf-brand wf-brand-mono" style={{ ...style, maskImage: `url("${uri}")`, WebkitMaskImage: `url("${uri}")` }} title={title} aria-hidden={!title} />;
  // A data: image can't run anything, whatever it holds.
  // eslint-disable-next-line @next/next/no-img-element -- an inline SVG icon, which next/image has nothing to optimize in
  return <img className="wf-brand" src={uri} width={size} height={size} alt={title ?? ""} title={title} />;
}

export const ProviderIcon = ({ provider, icon, label, size }: { provider: string; icon?: string; label?: string; size?: number }) => (
  <BrandIcon name={providerIconKey(provider, icon)} fallback={label ?? provider} title={label} size={size} />
);

/** A model's family icon, or its provider's when the family isn't known. */
export const ModelIcon = ({ model, provider, icon, size }: { model: string; provider: string; icon?: string; size?: number }) => (
  <BrandIcon name={modelIconKey(model) ?? providerIconKey(provider, icon)} fallback={model} size={size} />
);
