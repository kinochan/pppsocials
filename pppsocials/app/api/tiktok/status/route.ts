import { connection, NextResponse } from "next/server";
import { savedTikTokAccounts, tiktokConfig } from "@/src/lib/tiktok";

export async function GET() {
  await connection();
  try {
    const config = tiktokConfig();
    if (!config) return NextResponse.json({ enabled: false }, { headers: { "Cache-Control": "no-store" } });
    const accounts = await savedTikTokAccounts();
    return NextResponse.json({ enabled: true, accounts }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("Unable to load TikTok connection status. Check configuration and database.");
    return NextResponse.json({ message: "Unable to load TikTok connection status." }, { status: 500 });
  }
}
