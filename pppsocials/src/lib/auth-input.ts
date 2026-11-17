export async function readAuthInput(request: Request, maxBytes = 4096): Promise<Record<string, unknown> | null> {
  if (!request.body || !request.headers.get("content-type")?.startsWith("application/json")) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function validCredentials(email: unknown, password: unknown) {
  return typeof email === "string" && email.length <= 191 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
    typeof password === "string" && password.length >= 12 && password.length <= 128;
}
