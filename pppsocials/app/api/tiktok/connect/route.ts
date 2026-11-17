import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { requireApiAccess } from "@/src/lib/access";
import { tiktokBasicScope, tiktokConfig, tiktokStateCookie } from "@/src/lib/tiktok";

export async function POST(request: Request) {
  const denied = await requireApiAccess(request, true);
  if (denied) return denied;
  try {
    const config = tiktokConfig();
    if (!config) return NextResponse.json({ message: "TikTok connection is disabled." }, { status: 503 });
    if (request.headers.get("origin") !== config.baseUrl) {
      return NextResponse.json({ message: "Invalid request origin." }, { status: 403 });
    }
    const state = randomBytes(32).toString("hex");
    const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
    url.searchParams.set("client_key", config.clientKey);
    url.searchParams.set("redirect_uri", config.redirectUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", tiktokBasicScope);
    url.searchParams.set("state", state);
    url.searchParams.set("disable_auto_auth", "1");
    const response = NextResponse.redirect(url, 303);
    response.cookies.set(tiktokStateCookie, state, {
      httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 600,
    });
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch {
    console.error("TikTok connection could not be initialized. Check server configuration.");
    return NextResponse.json({ message: "TikTok connection is not configured correctly." }, { status: 503 });
  }
}
