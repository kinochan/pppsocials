import { connection, NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2";
import { db } from "@/src/lib/db";
import { requireApiAccess } from "@/src/lib/access";

interface VideoRow extends RowDataPacket {
  id: string;
  title: string;
  description: string | null;
  filename: string;
  original_filename: string | null;
}

export async function GET(request: Request) {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  await connection();
  try {
    const [videos] = await db.execute<VideoRow[]>(
      "SELECT CAST(id AS CHAR) AS id, title, description, filename, original_filename FROM videos ORDER BY id DESC"
    );
    return NextResponse.json(videos, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Failed to load library:", error);
    return NextResponse.json({ message: "Unable to load videos." }, { status: 500 });
  }
}
