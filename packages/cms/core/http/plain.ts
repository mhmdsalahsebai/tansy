/** Turns server data into what the API would have sent, for passing to client components. */
export const plain = <T>(value: unknown): T => JSON.parse(JSON.stringify(value)) as T;
