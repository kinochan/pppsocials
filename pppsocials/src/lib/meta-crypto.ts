import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

export function encryptMetaSecret(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64")).join(".");
}

export function decryptMetaSecret(value: string, key: Buffer): string {
  const parts = value.split(".");
  if (parts.length !== 3) throw new Error("Invalid encrypted Meta credential.");
  const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
