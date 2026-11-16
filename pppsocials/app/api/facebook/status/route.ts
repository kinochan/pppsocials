import { connection, NextResponse } from "next/server";
import { facebookConfig, savedFacebookPages } from "@/src/lib/facebook";

export async function GET() {
  await connection();
  try {
    const config = facebookConfig();
    if (!config) return NextResponse.json({ enabled: false }, { headers: { "Cache-Control": "no-store" } });
    const pages = await savedFacebookPages(config.key);
    return NextResponse.json({
      enabled: true,
      pages: pages?.map(({ id, name }) => ({ id, name })) ?? null,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("Unable to load Facebook connection status. Check configuration and database.");
    return NextResponse.json({ message: "Unable to load Facebook connection status." }, { status: 500 });
  }
}
