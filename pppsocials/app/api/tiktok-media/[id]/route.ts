import { createHash, timingSafeEqual } from "crypto";
import { constants } from "fs";
import { open } from "fs/promises";
import path from "path";
import type { RowDataPacket } from "mysql2";
import { db } from "@/src/lib/db";
import { tiktokConfig } from "@/src/lib/tiktok";
import { uploadFilePath } from "@/src/lib/videos";

interface MediaRow extends RowDataPacket {
  filepath: string;
  token_hash: string;
  file_device: string;
  file_inode: string;
  file_size: string;
  file_mtime_ns: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const tokens = new URL(request.url).searchParams.getAll("token");
  if (!uuid.test(id) || tokens.length !== 1 || !/^[0-9a-f]{64}$/.test(tokens[0])) {
    return new Response("Not found.", { status: 404 });
  }
  try {
    if (!tiktokConfig()?.directEnabled) return new Response("Not found.", { status: 404 });
    const [rows] = await db.execute<MediaRow[]>(
      `SELECT p.filepath, p.token_hash, p.file_device, p.file_inode, p.file_size, p.file_mtime_ns
       FROM tiktok_direct_posts p JOIN videos v ON v.id = p.video_id
       WHERE p.id = ? AND p.active = 1 AND p.status IN ('starting', 'processing', 'unknown')
       AND p.token_expires_at > UTC_TIMESTAMP() AND BINARY p.filepath = BINARY v.filepath
       AND BINARY p.filename = BINARY v.filename`, [id]
    );
    if (!rows.length || !/^[0-9a-f]{64}$/.test(rows[0].token_hash)) {
      return new Response("Not found.", { status: 404 });
    }
    const actual = createHash("sha256").update(tokens[0], "ascii").digest();
    if (!timingSafeEqual(actual, Buffer.from(rows[0].token_hash, "hex"))) {
      return new Response("Not found.", { status: 404 });
    }
    const filepath = uploadFilePath(rows[0].filepath);
    const file = await open(filepath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stats = await file.stat({ bigint: true });
      if (!stats.isFile() || stats.dev.toString() !== rows[0].file_device ||
          stats.ino.toString() !== rows[0].file_inode || stats.size.toString() !== rows[0].file_size ||
          stats.mtimeNs.toString() !== rows[0].file_mtime_ns) {
        await file.close();
        return new Response("Not found.", { status: 404 });
      }
      const size = Number(stats.size);
      let start = 0;
      let end = size - 1;
      const range = request.headers.get("range");
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) {
          await file.close();
          return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
        }
        if (match[1]) {
          start = Number(match[1]);
          end = match[2] ? Math.min(Number(match[2]), end) : end;
        } else {
          start = Math.max(size - Number(match[2]), 0);
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
          await file.close();
          return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
        }
      }
      const types: Record<string, string> = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm" };
      const headers = new Headers({
        "Content-Type": types[path.extname(filepath).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": String(end - start + 1), "Accept-Ranges": "bytes", "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow",
      });
      if (range) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
      if (request.method === "HEAD") {
        await file.close();
        return new Response(null, { status: range ? 206 : 200, headers });
      }
      const stream = file.createReadStream({ start, end, autoClose: true });
      const iterator = stream[Symbol.asyncIterator]();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const result = await iterator.next();
            if (result.done) controller.close();
            else controller.enqueue(result.value);
          } catch {
            console.error("TikTok media stream failed.");
            controller.error(new Error("Unable to stream video."));
          }
        },
        cancel() { stream.destroy(); },
      });
      return new Response(body, { status: range ? 206 : 200, headers });
    } catch (error) {
      await file.close();
      throw error;
    }
  } catch {
    console.error("TikTok media request failed. Check configuration and storage.");
    return new Response("Unable to load video.", { status: 503 });
  }
}

export const HEAD = GET;
