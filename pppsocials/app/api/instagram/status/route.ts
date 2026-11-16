import { connection, NextResponse } from "next/server";
import { instagramConfig, savedInstagramAccounts } from "@/src/lib/instagram";

export async function GET() {
  await connection();
  try {
    const config = instagramConfig();
    if (!config) {
      return NextResponse.json({ enabled: false }, { headers: { "Cache-Control": "no-store" } });
    }
    const accounts = await savedInstagramAccounts();
    return NextResponse.json({ enabled: true, accounts }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("Unable to load Instagram connection status. Check configuration and database.");
    return NextResponse.json({ message: "Unable to load Instagram connection status." }, { status: 500 });
  }
}
