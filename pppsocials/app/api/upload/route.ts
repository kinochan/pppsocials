import { randomUUID } from "crypto";
import { mkdir, open, unlink } from "fs/promises";
import { NextResponse } from "next/server";
import path from "path";
import { db } from "@/src/lib/db";

export async function POST(request: Request) {
  try {
    const data = await request.formData();
    const file = data.get("file");
    const title = data.get("title");
    const description = data.get("description");

    if (
      !(file instanceof File) ||
      typeof title !== "string" ||
      !title.trim() ||
      title.trim().length > 255 ||
      typeof description !== "string"
    ) {
      return NextResponse.json(
        { success: false, message: "Provide a video, a title (up to 255 characters), and a text description." },
        { status: 400 }
      );
    }

    const uploadDir = path.join(process.cwd(), "uploads");
    await mkdir(uploadDir, { recursive: true });

    const safeName = file.name.replace(/[^\w.-]/g, "_").slice(-180);
    const filename = `${randomUUID()}-${safeName}`;
    const relativePath = path.join("uploads", filename);
    const uploadPath = path.join(process.cwd(), relativePath);
    const handle = await open(uploadPath, "wx");

    try {
      try {
        await handle.writeFile(Buffer.from(await file.arrayBuffer()));
      } finally {
        await handle.close();
      }

      await db.execute(
        "INSERT INTO videos (title, description, filepath) VALUES (?, ?, ?)",
        [title.trim(), description, relativePath]
      );
    } catch (error) {
      try {
        await unlink(uploadPath);
      } catch (cleanupError) {
        console.error("Failed to remove incomplete upload:", cleanupError);
      }
      throw error;
    }

    return NextResponse.json({
      success: true,
      filename,
      title: title.trim(),
      description,
      savedTo: uploadPath,
    });
  } catch (error) {
    console.error("Upload failed:", error);
    return NextResponse.json(
      { success: false, message: "Unable to save the upload." },
      { status: 500 }
    );
  }
}
