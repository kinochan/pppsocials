import { randomUUID } from "crypto";
import { createWriteStream } from "fs";
import { mkdir, unlink } from "fs/promises";
import { NextResponse } from "next/server";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import busboy from "busboy";
import { db } from "@/src/lib/db";

const maxVideoBytes = 1_000_000_000;

export async function POST(request: Request) {
  let uploadPath: string | undefined;
  let created = false;
  let fileWrite: Promise<void> | undefined;

  try {
    if (!request.body) {
      return NextResponse.json({ success: false, message: "Provide a video and its details." }, { status: 400 });
    }

    const body = request.body;
    let parser: ReturnType<typeof busboy>;
    try {
      parser = busboy({
        headers: { "content-type": request.headers.get("content-type") ?? "" },
        limits: { fileSize: maxVideoBytes + 1, fieldSize: 1_048_576, fields: 2, files: 1 },
      });
    } catch {
      return NextResponse.json({ success: false, message: "Invalid upload form." }, { status: 400 });
    }
    await mkdir(path.join(process.cwd(), "uploads"), { recursive: true });

    let title: string | undefined;
    let description: string | undefined;
    let filename: string | undefined;
    let relativePath: string | undefined;
    let invalidForm = false;
    let tooLarge = false;
    let fileError: unknown;

    parser.on("field", (name, value, info) => {
      if (info.valueTruncated) invalidForm = true;
      if (name === "title") title = value;
      else if (name === "description") description = value;
      else invalidForm = true;
    });
    parser.on("file", (name, file, info) => {
      if (name !== "file" || info.filename === undefined) {
        invalidForm = true;
        file.resume();
        return;
      }

      const safeName = info.filename.replace(/[^\w.-]/g, "_").slice(-180);
      filename = `${randomUUID()}-${safeName}`;
      relativePath = path.join("uploads", filename);
      uploadPath = path.join(process.cwd(), "uploads", filename);
      const destination = uploadPath;

      file.on("limit", () => { tooLarge = true; });
      const output = createWriteStream(destination, { flags: "wx" });
      output.on("open", () => { created = true; });
      fileWrite = pipeline(file, output).catch((error: unknown) => {
        fileError = error;
        parser.destroy(error instanceof Error ? error : new Error("Unable to write upload."));
      });
    });
    parser.on("fieldsLimit", () => { invalidForm = true; });
    parser.on("filesLimit", () => { invalidForm = true; });

    try {
      const source = Readable.from((async function* () {
        const reader = body.getReader();
        let finished = false;
        try {
          while (true) {
            const result = await reader.read();
            if (result.done) {
              finished = true;
              break;
            }
            yield result.value;
          }
        } finally {
          if (!finished) await reader.cancel();
          reader.releaseLock();
        }
      })());
      await pipeline(source, parser);
    } finally {
      await fileWrite;
    }
    if (fileError) throw fileError;

    if (tooLarge) {
      if (created && uploadPath) {
        await unlink(uploadPath);
        created = false;
      }
      return NextResponse.json({ success: false, message: "Video must be 1 GB or smaller." }, { status: 413 });
    }
    if (invalidForm || !filename || !relativePath || typeof title !== "string" ||
        !title.trim() || title.trim().length > 255 || typeof description !== "string") {
      if (created && uploadPath) {
        await unlink(uploadPath);
        created = false;
      }
      return NextResponse.json(
        { success: false, message: "Provide a video, a title (up to 255 characters), and a text description." },
        { status: 400 }
      );
    }

    await db.execute(
      "INSERT INTO videos (title, description, filename, filepath) VALUES (?, ?, ?, ?)",
      [title.trim(), description, filename, relativePath]
    );

    return NextResponse.json({
      success: true,
      filename,
      title: title.trim(),
      description,
      savedTo: uploadPath,
    });
  } catch (error) {
    if (created && uploadPath) {
      try {
        await unlink(uploadPath);
      } catch (cleanupError) {
        console.error("Failed to remove incomplete upload:", cleanupError);
      }
    }
    console.error("Upload failed:", error);
    return NextResponse.json(
      { success: false, message: "Unable to save the upload." },
      { status: 500 }
    );
  }
}
