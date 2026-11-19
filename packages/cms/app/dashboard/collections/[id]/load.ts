import { notFound } from "next/navigation";
import type { EditorCatalog } from "../../../../components/fields/types";
import { listBlockLayouts } from "../../../../core/blocks/layouts";
import { listBlockTypes } from "../../../../core/blocks/service";
import { getCollection } from "../../../../core/content/collections";
import { parseId } from "../../../../core/content/ids";
import { fieldCatalogue } from "../../../../core/fields/registry";
import { HttpError } from "../../../../core/http/errors";
import { plain } from "../../../../core/http/plain";
import type { Collection } from "../../../../types/content";

/** Schema only, for pages that have already called requirePage. Records load through the guarded API. */
export async function loadSchema(rawId: string, canSaveLayouts = false) {
  try {
    const [collection, blockTypes, blockLayouts] = await Promise.all([getCollection(parseId(rawId)), listBlockTypes(), listBlockLayouts()]);
    return { collection: plain<Collection>(collection), catalog: plain<EditorCatalog>({ fieldTypes: fieldCatalogue(), blockTypes, blockLayouts, canSaveLayouts }) };
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) notFound();
    throw error;
  }
}
