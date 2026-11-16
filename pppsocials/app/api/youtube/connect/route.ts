import { createHash, randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { youtubeConfig, youtubeReadonlyScope, youtubeStateCookie } from "@/src/lib/youtube";

export async function POST(request: Request) {
  try {
    const config = youtubeConfig();
    if (!config) return NextResponse.json({ message: "YouTube connection is disabled." }, { status: 503 });
    if (request.headers.get("origin") !== config.baseUrl) {
      return NextResponse.json({ message: "Invalid request origin." }, { status: 403 });
    }
    const state = randomBytes(32).toString("hex");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", config.redirectUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", youtubeReadonlyScope);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent select_account");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    const response = NextResponse.redirect(url, 303);
    response.cookies.set(youtubeStateCookie, `${state}.${verifier}`, {
      httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 600,
    });
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch {
    console.error("YouTube connection could not be initialized. Check server configuration.");
    return NextResponse.json({ message: "YouTube connection is not configured correctly." }, { status: 503 });
  }
}
