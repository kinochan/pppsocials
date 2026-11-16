import { mkdir, writeFile } from "fs/promises";
import { NextResponse } from "next/server";
import path from "path";

export async function POST(request: Request) {
  try {
    const data = await request.formData();

    const file = data.get("file") as File;
const title = data.get("title");
const description = data.get("description");
    if (!file) {
      return NextResponse.json({
        success: false,
        message: "No file uploaded",
      });
    }

    const uploadDir = path.join(
      process.cwd(),
      "uploads"
    );

    await mkdir(uploadDir, {
      recursive: true,
    });

    const uploadPath = path.join(
      uploadDir,
      file.name
    );

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    await writeFile(uploadPath, buffer);

    return NextResponse.json({
      success: true,
      filename: file.name,
      title,
      description,
      savedTo: uploadPath,
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json({
      success: false,
      error: String(error),
    });
  }
}