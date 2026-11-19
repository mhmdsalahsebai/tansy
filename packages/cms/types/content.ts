export interface Field {
  id: number;
  name: string;
  type: string;
  config: { description?: string } & Record<string, unknown> | null;
  collectionId: number;
}

export interface Collection {
  id: number;
  name: string;
  /** The name in other interface languages. */
  labels?: Record<string, string> | null;
  slug: string;
  type?: string;
  viewQuery?: string | null;
  urlPattern?: string | null;
  description: string | null;
  /** Off when null. */
  localization?: { enabled: boolean; fallback: "chain" | "none"; fieldFallback: boolean } | null;
  /** Records are kept apart by the scope provider's value, such as a tenant (core/scope). */
  scoped?: boolean;
  /** Publishing needs `record:publish`. Everyone else submits changes for review. */
  reviewRequired?: boolean;
  fields: Field[];
  listRule: string | null;
  viewRule: string | null;
  createRule: string | null;
  updateRule: string | null;
  deleteRule: string | null;
}

export interface ContentItem {
  id: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  values: Array<{ fieldId: number; value: unknown; field: Field }>;
}

export interface Paginated<T> {
  page: number;
  perPage: number;
  totalItems: number;
  items: T[];
}
