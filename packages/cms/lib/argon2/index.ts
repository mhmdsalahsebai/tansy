import argon2 from "argon2";

// OWASP Password Storage Cheat Sheet minimum for Argon2id: m=19 MiB, t=2, p=1.
const options = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (password: string) => argon2.hash(password, options);

export const verifyPassword = (hash: string, password: string) => argon2.verify(hash, password);
