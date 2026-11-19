import { generateImage, generateText } from "ai";
import type { AiProvider, AiSettings } from "./provider";

export type AspectRatio = `${number}:${number}`;

export const ASPECT_RATIOS = ["1:1", "16:9", "4:3", "3:2", "2:3", "9:16"] as const;

/** Thrown when a model answers without a picture: trying again won't help. */
export class NoPicture extends Error {}

/**
 * Draws one picture with a provider's model: its image model when the adapter has one for
 * that id, or else a language model that answers with pictures, such as Gemini's.
 */
export async function drawPicture(options: { provider: AiProvider; settings: AiSettings; modelId: string; prompt: string; aspectRatio?: AspectRatio; abortSignal?: AbortSignal }): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const { provider, settings, modelId, prompt, aspectRatio } = options;
  const abortSignal = options.abortSignal ?? AbortSignal.timeout(5 * 60_000);
  const imageModel = provider.imageModel?.(settings, modelId);
  if (imageModel) {
    const { image } = await generateImage({ model: imageModel, prompt, ...(aspectRatio ? { aspectRatio } : {}), maxRetries: 0, abortSignal });
    return { bytes: image.uint8Array, mediaType: image.mediaType || "image/png" };
  }
  const result = await generateText({ model: provider.model(settings, modelId), prompt: aspectRatio ? `${prompt}\nAspect ratio: ${aspectRatio}.` : prompt, maxRetries: 0, abortSignal });
  const file = result.files.find((item) => item.mediaType.startsWith("image/"));
  if (!file) throw new NoPicture(`${modelId} answered without a picture. Choose a model that draws.`);
  return { bytes: file.uint8Array, mediaType: file.mediaType };
}
