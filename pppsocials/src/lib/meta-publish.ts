import type { FileHandle } from "fs/promises";

export class PublishError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function metaJson(url: string, options: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, { ...options, cache: "no-store", redirect: "error" });
  if (!response.ok) throw new PublishError(`Meta returned HTTP ${response.status}.`);
  const data: unknown = await response.json();
  if (!isRecord(data) || data.error) throw new PublishError("Meta returned an invalid response.");
  return data;
}

export async function uploadMetaVideo(
  file: FileHandle,
  size: number,
  url: string,
  token: string,
  updateProgress: (percent: number) => Promise<void>,
) {
  const stream = file.createReadStream({ autoClose: false });
  try {
    const iterator = stream[Symbol.asyncIterator]();
    let bytesRead = 0;
    let lastPercent = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await iterator.next();
          if (result.done) {
            controller.close();
            return;
          }
          bytesRead += result.value.byteLength;
          const percent = Math.min(99, Math.floor(bytesRead * 100 / size));
          if (percent >= lastPercent + 5) {
            await updateProgress(percent);
            lastPercent = percent;
          }
          controller.enqueue(result.value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel() {
        stream.destroy();
      },
    });
    const options = {
      method: "POST",
      headers: {
        Authorization: `OAuth ${token}`,
        offset: "0",
        file_size: String(size),
        "Content-Length": String(size),
        "Content-Type": "application/octet-stream",
      },
      body,
      duplex: "half" as const,
      signal: AbortSignal.timeout(45 * 60 * 1000),
    };
    const uploaded = await metaJson(url, options);
    if (uploaded.success !== true) throw new PublishError("Meta did not confirm the upload.");
    if (bytesRead !== size) throw new PublishError("Meta confirmed an incomplete upload.");
    await updateProgress(100);
  } finally {
    stream.destroy();
  }
}
