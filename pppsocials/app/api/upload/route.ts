import { randomUUID } from "crypto";
import { createWriteStream } from "fs";
import { mkdir, unlink } from "fs/promises";
import { NextResponse } from "next/server";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import busboy from "busboy";
import type { RowDataPacket } from "mysql2";
import { findDuplicates, removeUnreferencedFile, safeFilename, uploadFilePath, validOriginalFilename, validVideoId, withVideoLock } from "@/src/lib/videos";

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
        defParamCharset: "utf8",
        limits: { fileSize: maxVideoBytes + 1, fieldSize: 1_048_576, fields: 4, files: 1 },
      });
    } catch {
      return NextResponse.json({ success: false, message: "Invalid upload form." }, { status: 400 });
    }
    await mkdir(path.join(process.cwd(), "uploads"), { recursive: true });

    let title: string | undefined;
    let description: string | undefined;
    let filename: string | undefined;
    let originalFilename: string | undefined;
    let relativePath: string | undefined;
    let replaceId: string | undefined;
    let expectedFilename: string | undefined;
    let invalidForm = false;
    let tooLarge = false;
    let fileError: unknown;

    parser.on("field", (name, value, info) => {
      if (info.valueTruncated) invalidForm = true;
      if (name === "title" && title === undefined) title = value;
      else if (name === "description" && description === undefined) description = value;
      else if (name === "replaceId" && replaceId === undefined) replaceId = value;
      else if (name === "expectedFilename" && expectedFilename === undefined) expectedFilename = value;
      else invalidForm = true;
    });
    parser.on("file", (name, file, info) => {
      if (name !== "file" || !info.filename || !validOriginalFilename(info.filename)) {
        invalidForm = true;
        file.resume();
        return;
      }

      originalFilename = info.filename;
      const safeName = safeFilename(info.filename);
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
    if (invalidForm || !filename || !originalFilename || !relativePath || typeof title !== "string" ||
        !title.trim() || title.trim().length > 255 || typeof description !== "string" ||
        (replaceId !== undefined && (!validVideoId(replaceId) || !expectedFilename)) ||
        (expectedFilename !== undefined && !replaceId)) {
      if (created && uploadPath) {
        await unlink(uploadPath);
        created = false;
      }
      return NextResponse.json(
        { success: false, message: "Provide a video, a title (up to 255 characters), and a text description." },
        { status: 400 }
      );
    }

    const newFilename = filename;
    const newOriginalFilename = originalFilename;
    const newRelativePath = relativePath;
    const newTitle = title.trim();
    const newDescription = description;
    const result = await withVideoLock(async (connection) => {
      const matches = await findDuplicates(connection, newOriginalFilename);
      if (!replaceId && matches.length) return { conflict: true };
      if (replaceId) {
        const match = matches.find((item) => item.id === replaceId && item.filename === expectedFilename);
        if (!match) return { conflict: true };
        const [rows] = await connection.execute<RowDataPacket[]>(
          "SELECT filepath FROM videos WHERE id = ?", [replaceId]
        );
        if (!rows.length) return { conflict: true };
        const oldPath: string = rows[0].filepath;
        uploadFilePath(oldPath);
        await connection.execute(
          "UPDATE videos SET title = ?, description = ?, filename = ?, original_filename = ?, filepath = ? WHERE id = ?",
          [newTitle, newDescription, newFilename, newOriginalFilename, newRelativePath, replaceId]
        );
        created = false;
        try {
          await removeUnreferencedFile(connection, oldPath);
        } catch (error) {
          console.error("Could not clean up the replaced video:", error);
          return { conflict: false, warning: "The video was replaced, but the old file could not be removed from the server." };
        }
      } else {
        await connection.execute(
          "INSERT INTO videos (title, description, filename, original_filename, filepath) VALUES (?, ?, ?, ?, ?)",
          [newTitle, newDescription, newFilename, newOriginalFilename, newRelativePath]
        );
        created = false;
      }
      return { conflict: false };
    });

    if (result.conflict) {
      if (created && uploadPath) {
        await unlink(uploadPath);
        created = false;
      }
      return NextResponse.json(
        { success: false, message: "Matching videos changed. Please check and confirm the replacement again." },
        { status: 409 }
      );
    }

    return NextResponse.json({
      success: true,
      filename,
      title: title.trim(),
      description,
      savedTo: uploadPath,
      warning: result.warning,
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
