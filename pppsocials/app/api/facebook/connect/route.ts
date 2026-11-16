import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { facebookConfig, facebookStateCookie } from "@/src/lib/facebook";

export async function POST(request: Request) {
  try {
    const config = facebookConfig();
    if (!config) return NextResponse.json({ message: "Facebook connection is disabled." }, { status: 503 });
    if (request.headers.get("origin") !== config.baseUrl) {
      return NextResponse.json({ message: "Invalid request origin." }, { status: 403 });
    }
    const state = randomBytes(32).toString("hex");
    const url = new URL("https://www.facebook.com/v27.0/dialog/oauth");
    url.searchParams.set("client_id", config.appId);
    url.searchParams.set("config_id", config.configId);
    url.searchParams.set("redirect_uri", config.redirectUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("override_default_response_type", "true");
    url.searchParams.set("state", state);
    const response = NextResponse.redirect(url, 303);
    response.cookies.set(facebookStateCookie, state, {
      httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 600,
    });
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch {
    console.error("Facebook connection could not be initialized. Check server configuration.");
    return NextResponse.json({ message: "Facebook connection is not configured correctly." }, { status: 503 });
  }
}
