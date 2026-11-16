import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { instagramConfig, stateCookie } from "@/src/lib/instagram";

export async function POST(request: Request) {
  try {
    const config = instagramConfig();
    if (!config) {
      return NextResponse.json({ message: "Instagram connection is disabled." }, { status: 503 });
    }
    if (request.headers.get("origin") !== config.baseUrl) {
      return NextResponse.json({ message: "Invalid request origin." }, { status: 403 });
    }
    const state = randomBytes(32).toString("hex");
    const loginUrl = new URL("https://www.facebook.com/dialog/oauth");
    loginUrl.searchParams.set("client_id", config.appId);
    loginUrl.searchParams.set("config_id", config.configId);
    loginUrl.searchParams.set("redirect_uri", config.redirectUrl);
    loginUrl.searchParams.set("response_type", "code");
    loginUrl.searchParams.set("state", state);
    loginUrl.searchParams.set("prompt", "login");
    const response = NextResponse.redirect(loginUrl, 303);
    response.cookies.set(stateCookie, state, {
      httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 600,
    });
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch {
    console.error("Instagram connection could not be initialized. Check server configuration.");
    return NextResponse.json({ message: "Instagram connection is not configured correctly." }, { status: 503 });
  }
}
