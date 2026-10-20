import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Encrypt a secret (a Google refresh token) before it goes into the database.
//
// AES-256-GCM: encrypts AND authenticates. Any change to the stored value, or the wrong
// key, makes decryption fail loudly instead of returning garbage.
//
// `context` is bound in as associated data (AAD): it is not stored inside the ciphertext,
// but decryption must be given the same value. Encrypting with the account's email means a
// token copied onto another account's row will not decrypt.
//
// Format: "v1.<12-byte IV>.<ciphertext + 16-byte tag>", base64url. "v1" leaves room to
// change the scheme or rotate keys later.

const VERSION = "v1";

export class DecryptError extends Error {}

export function seal(plaintext: string, key: Buffer, context: string): string {
  const iv = randomBytes(12); // never reused: a fresh IV for every encryption
  const cipher = createCipheriv("aes-256-gcm", checkKey(key), iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `${VERSION}.${iv.toString("base64url")}.${body.toString("base64url")}`;
}

export function open(sealed: string, key: Buffer, context: string): string {
  const [version, ivPart, bodyPart] = sealed.split(".");
  if (version !== VERSION || !ivPart || !bodyPart) throw new DecryptError("unrecognised encrypted value");
  const iv = Buffer.from(ivPart, "base64url");
  const body = Buffer.from(bodyPart, "base64url");
  if (iv.length !== 12 || body.length < 17) throw new DecryptError("malformed encrypted value");
  const decipher = createDecipheriv("aes-256-gcm", checkKey(key), iv);
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(body.subarray(body.length - 16));
  try {
    return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key, wrong context, or tampered data: GCM can't tell which, and neither do we.
    throw new DecryptError("could not decrypt (wrong key, or the value was changed)");
  }
}

function checkKey(key: Buffer): Buffer {
  if (key.length !== 32) throw new Error("encryption key must be 32 bytes");
  return key;
}
