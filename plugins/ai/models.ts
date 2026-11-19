import { createHash } from "node:crypto";
import { guessCapabilities, type AiProvider, type AiSettings, type ModelCapabilities, type ModelChoice } from "./provider";
import type { Catalog, CatalogEntry } from "./workflow/check";

/** A provider's models, listed at most every few minutes for the menus that offer them. */
const MODELS_FOR = 10 * 60 * 1000;
const modelLists = new Map<string, { at: number; options: Promise<ModelChoice[]> }>();

export function listModels(provider: AiProvider, settings: AiSettings): Promise<ModelChoice[]> {
  // Keyed by the settings too, so a new key or server lists again. Only a hash is kept.
  const key = `${provider.id}:${createHash("sha256").update(JSON.stringify(settings)).digest("hex")}`;
  const cached = modelLists.get(key);
  if (cached && Date.now() - cached.at < MODELS_FOR) return cached.options;
  const options = provider.models!(settings).then((list) => list.slice(0, 2000));
  options.catch(() => modelLists.delete(key));
  if (modelLists.size > 50) modelLists.clear();
  modelLists.set(key, { at: Date.now(), options });
  return options;
}

/** What a model can do: as its provider lists it, or as its id suggests when it isn't listed. */
export async function capabilitiesOf(provider: AiProvider, settings: AiSettings, modelId: string): Promise<ModelCapabilities> {
  if (provider.models) {
    try {
      const found = (await listModels(provider, settings)).find((model) => model.value === modelId);
      if (found?.capabilities) return found.capabilities;
    } catch {
      // The list is only a better guess; the id still says something.
    }
  }
  return guessCapabilities(modelId);
}

/** Every provider's models with what each can do, or why they couldn't be listed. Never a key. */
export async function catalogOf(providers: AiProvider[], settings: AiSettings): Promise<Catalog> {
  const entries = await Promise.all(providers.map(async (provider): Promise<CatalogEntry> => {
    const entry = { id: provider.id, label: provider.label, icon: provider.icon, ready: provider.ready(settings), images: Boolean(provider.imageModel), defaultModel: provider.defaultModel };
    if (!entry.ready || !provider.models) return { ...entry, models: null };
    try {
      return { ...entry, models: await listModels(provider, settings) };
    } catch (error) {
      return { ...entry, models: null, error: error instanceof Error ? error.message : "The models couldn't be listed." };
    }
  }));
  return { providers: entries };
}
