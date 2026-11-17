import { NextResponse } from "next/server";
import { requireApiAccess } from "@/src/lib/access";
import { db } from "@/src/lib/db";
import { findDuplicates, validOriginalFilename } from "@/src/lib/videos";

export async function POST(request: Request) {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ message: "Invalid filename." }, { status: 400 });
  }
  if (typeof input !== "object" || input === null || !("filename" in input) ||
      typeof input.filename !== "string" || !validOriginalFilename(input.filename)) {
    return NextResponse.json({ message: "Invalid filename." }, { status: 400 });
  }
  try {
    const matches = await findDuplicates(db, input.filename);
    return NextResponse.json(matches, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Failed to check video filenames:", error);
    return NextResponse.json({ message: "Unable to check for existing videos." }, { status: 500 });
  }
}
