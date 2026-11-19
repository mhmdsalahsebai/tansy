/** Safe to import in the browser, unlike stream.ts. */
export const MAX_BLOCK_DEPTH = 8;

export interface Block {
  id: string;
  type: string;
  v: number;
  value: Record<string, unknown>;
}
