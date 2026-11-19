import "server-only";
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";

/**
 * Archives are encrypted in chunks (the STREAM construction): AES-256-GCM per
 * 64 KiB, each with its own counter in the nonce and a flag on the last one, so
 * reordering, dropping or cutting off chunks fails authentication. One GCM
 * message would cap an archive at 64 GiB and give no answer until its end.
 *
 *   header = "NCMSBAK1" | salt (16) | nonce prefix (7)
 *   chunk  = ciphertext | tag (16), nonce = prefix | counter (u32 BE) | last (u8)
 *
 * The key comes from TANSY_BACKUP_KEY through HKDF with the archive's own salt.
 */

export const ENCRYPTED_MAGIC = Buffer.from("NCMSBAK1", "ascii");
// On-disk format constants. They keep the pre-rename spelling on purpose: they are the key
// derivation's domain separators, so changing them would make every existing archive
// undecryptable. Rename them only together with a new ENCRYPTED_MAGIC and a reader for both.
const BACKUP_KDF_INFO = "next-cms backup v1";
const BACKUP_FINGERPRINT_INFO = "next-cms backup fingerprint";
const SALT = 16;
const PREFIX = 7;
const HEADER = ENCRYPTED_MAGIC.length + SALT + PREFIX;
const CHUNK = 64 * 1024;
const TAG = 16;

/** HKDF isn't made to stretch a password, so the key has to be long and random to begin with. */
export const MIN_BACKUP_KEY = 32;

export const backupKey = () => process.env.TANSY_BACKUP_KEY || null;

export function assertBackupKey(key: string | null): asserts key is string {
  if (!key) throw new Error("Set TANSY_BACKUP_KEY to encrypt backups, such as the output of openssl rand -base64 32. Keep a copy somewhere other than the backups.");
  if (key.length < MIN_BACKUP_KEY) throw new Error(`TANSY_BACKUP_KEY must be at least ${MIN_BACKUP_KEY} random characters, such as the output of openssl rand -base64 32.`);
}

const deriveKey = (secret: string, salt: Buffer) => Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), salt, BACKUP_KDF_INFO, 32));

function nonce(prefix: Buffer, counter: number, last: boolean) {
  const value = Buffer.alloc(12);
  prefix.copy(value, 0);
  value.writeUInt32BE(counter, PREFIX);
  value[11] = last ? 1 : 0;
  return value;
}

class Chunks {
  private parts: Buffer[] = [];
  length = 0;
  push(chunk: Buffer) {
    this.parts.push(chunk);
    this.length += chunk.length;
  }
  take(size: number) {
    const all = Buffer.concat(this.parts, this.length);
    this.parts = [all.subarray(size)];
    this.length -= size;
    return all.subarray(0, size);
  }
}

export function encryptStream(secret: string): Transform {
  assertBackupKey(secret);
  const salt = randomBytes(SALT);
  const prefix = randomBytes(PREFIX);
  const header = Buffer.concat([ENCRYPTED_MAGIC, salt, prefix]);
  const key = deriveKey(secret, salt);
  const pending = new Chunks();
  let counter = 0;

  const seal = (plain: Buffer, last: boolean) => {
    if (counter === 0xffffffff) throw new Error("The archive is too large to encrypt.");
    const cipher = createCipheriv("aes-256-gcm", key, nonce(prefix, counter++, last));
    cipher.setAAD(header);
    return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  };

  return new Transform({
    construct(done) {
      this.push(header);
      done();
    },
    transform(chunk: Buffer, _encoding, done: TransformCallback) {
      try {
        pending.push(chunk);
        // Strictly more than a chunk, so the last chunk is always the one flush seals.
        while (pending.length > CHUNK) this.push(seal(pending.take(CHUNK), false));
        done();
      } catch (error) {
        done(error as Error);
      }
    },
    flush(done) {
      try {
        this.push(seal(pending.take(pending.length), true));
        done();
      } catch (error) {
        done(error as Error);
      }
    },
  });
}

const WRONG_KEY = "The archive could not be decrypted: TANSY_BACKUP_KEY is not the key it was made with, or the archive is damaged.";

export function decryptStream(secret: string): Transform {
  assertBackupKey(secret);
  const pending = new Chunks();
  let header: Buffer | null = null;
  let prefix: Buffer;
  let key: Buffer;
  let counter = 0;

  const open = (sealed: Buffer, last: boolean) => {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce(prefix, counter++, last));
    decipher.setAAD(header!);
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
    try {
      return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG)), decipher.final()]);
    } catch {
      throw new Error(WRONG_KEY);
    }
  };

  return new Transform({
    transform(chunk: Buffer, _encoding, done: TransformCallback) {
      try {
        pending.push(chunk);
        if (!header) {
          if (pending.length < HEADER) return done();
          header = Buffer.from(pending.take(HEADER));
          if (!header.subarray(0, ENCRYPTED_MAGIC.length).equals(ENCRYPTED_MAGIC)) throw new Error("This is not an encrypted tansy backup.");
          prefix = header.subarray(ENCRYPTED_MAGIC.length + SALT);
          key = deriveKey(secret, header.subarray(ENCRYPTED_MAGIC.length, ENCRYPTED_MAGIC.length + SALT));
        }
        while (pending.length > CHUNK + TAG) this.push(open(pending.take(CHUNK + TAG), false));
        done();
      } catch (error) {
        done(error as Error);
      }
    },
    flush(done) {
      try {
        if (!header || pending.length < TAG) throw new Error("The archive is cut short.");
        this.push(open(pending.take(pending.length), true));
        done();
      } catch (error) {
        done(error as Error);
      }
    },
  });
}

/**
 * Tells whether a backup was made with the same secrets as this server, without
 * revealing them. Settings, two-factor secrets and webhook secrets in the
 * database only decrypt with the secrets they were stored under.
 */
export const secretFingerprint = (secret: string | undefined) =>
  secret ? createHmac("sha256", secret).update(BACKUP_FINGERPRINT_INFO).digest("hex").slice(0, 16) : null;
