import { connection, NextResponse } from "next/server";
import { requireApiAccess } from "@/src/lib/access";
import { savedYouTubeChannels, youtubeConfig } from "@/src/lib/youtube";

export async function GET(request: Request) {
  const denied = await requireApiAccess(request, true);
  if (denied) return denied;
  await connection();
  try {
    const config = youtubeConfig();
    if (!config) return NextResponse.json({ enabled: false }, { headers: { "Cache-Control": "no-store" } });
    const channels = await savedYouTubeChannels();
    return NextResponse.json({ enabled: true, channels }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("Unable to load YouTube connection status. Check configuration and database.");
    return NextResponse.json({ message: "Unable to load YouTube connection status." }, { status: 500 });
  }
}
