import { connection, NextResponse } from "next/server";
import { requireApiAccess } from "@/src/lib/access";
import { savedTikTokAccounts, tiktokConfig } from "@/src/lib/tiktok";

export async function GET(request: Request) {
  const denied = await requireApiAccess(request, true);
  if (denied) return denied;
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
