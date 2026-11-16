import { constants } from "fs";
import { open } from "fs/promises";
import type { RowDataPacket } from "mysql2";
import path from "path";
import { db } from "@/src/lib/db";
import { removeUnreferencedFile, uploadFilePath, validVideoId, withVideoLock } from "@/src/lib/videos";

interface VideoRow extends RowDataPacket {
  filepath: string;
}

const contentTypes: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
};

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!validVideoId(id)) {
    return new Response("Video not found.", { status: 404 });
  }

  try {
    const [rows] = await db.execute<VideoRow[]>("SELECT filepath FROM videos WHERE id = ?", [id]);
    if (!rows.length) return new Response("Video not found.", { status: 404 });

    const storedPath = rows[0].filepath;
    const filename = path.basename(storedPath);
    if (path.dirname(storedPath) !== "uploads" || filename === "." || filename === "..") {
      console.error("Invalid library video path for id:", id);
      return new Response("Unable to load video.", { status: 500 });
    }
    const filePath = path.join(process.cwd(), "uploads", filename);

    let file;
    try {
      file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return new Response("Video file not found.", { status: 404 });
      }
      throw error;
    }

    try {
      const stats = await file.stat();
      const { size } = stats;
      if (!stats.isFile()) {
        await file.close();
        return new Response("Video file not found.", { status: 404 });
      }

      let start = 0;
      let end = size - 1;
      const range = request.headers.get("range");
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2]) || size === 0) {
          await file.close();
          return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
        }
        if (match[1]) {
          start = Number(match[1]);
          end = match[2] ? Math.min(Number(match[2]), end) : end;
        } else {
          const suffix = Number(match[2]);
          start = Math.max(size - suffix, 0);
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
          await file.close();
          return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
        }
      }

      const headers = new Headers({
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
        "Content-Length": String(size === 0 ? 0 : end - start + 1),
        "Content-Type": contentTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      });
      if (range) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
      if (size === 0) {
        await file.close();
        return new Response(null, { headers });
      }

      const stream = file.createReadStream({ start, end, autoClose: true });
      const iterator = stream[Symbol.asyncIterator]();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const result = await iterator.next();
            if (result.done) controller.close();
            else controller.enqueue(result.value);
          } catch (error) {
            console.error("Failed to stream library video:", error);
            controller.error(error);
          }
        },
        cancel() {
          stream.destroy();
        },
      });
      return new Response(body, { status: range ? 206 : 200, headers });
    } catch (error) {
      await file.close();
      throw error;
    }
  } catch (error) {
    console.error("Failed to load library video:", error);
    return new Response("Unable to load video.", { status: 500 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!validVideoId(id)) return new Response("Video not found.", { status: 404 });

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return Response.json({ message: "Invalid deletion request." }, { status: 400 });
  }
  if (typeof input !== "object" || input === null || !("filename" in input) ||
      typeof input.filename !== "string" || !input.filename) {
    return Response.json({ message: "Invalid deletion request." }, { status: 400 });
  }
  const expectedFilename = input.filename;

  try {
    const result = await withVideoLock(async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>(
        "SELECT filename, filepath FROM videos WHERE id = ?", [id]
      );
      if (!rows.length || rows[0].filename !== expectedFilename) return { conflict: true };
      const storedPath: string = rows[0].filepath;
      uploadFilePath(storedPath);
      await connection.execute("DELETE FROM videos WHERE id = ?", [id]);
      try {
        await removeUnreferencedFile(connection, storedPath);
      } catch (error) {
        console.error("Could not clean up the deleted video:", error);
        return { conflict: false, warning: "The video was removed from the library, but its file could not be removed from the server." };
      }
      return { conflict: false };
    });
    if (result.conflict) return Response.json({ message: "The video changed. Refresh the library and try again." }, { status: 409 });
    return Response.json({ success: true, warning: result.warning });
  } catch (error) {
    console.error("Failed to delete video:", error);
    return Response.json({ message: "Unable to delete the video." }, { status: 500 });
  }
}
