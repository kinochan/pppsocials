import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { connectTikTok, TikTokConnectionError, tiktokConfig, tiktokStateCookie } from "@/src/lib/tiktok";

export async function GET(request: NextRequest) {
  let config;
  try {
    config = tiktokConfig();
  } catch {
    console.error("TikTok callback configuration is invalid.");
    return NextResponse.json({ message: "TikTok connection is not configured correctly." }, { status: 503 });
  }
  if (!config) return NextResponse.json({ message: "TikTok connection is disabled." }, { status: 503 });

  const redirect = (result: string) => {
    const url = new URL("/settings", config.baseUrl);
    url.searchParams.set("tiktok", result);
    const response = NextResponse.redirect(url, 303);
    response.cookies.set(tiktokStateCookie, "", {
      httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0,
    });
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  };

  const state = request.nextUrl.searchParams.get("state");
  const expected = request.cookies.get(tiktokStateCookie)?.value;
  if (!state || !expected || !/^[0-9a-f]{64}$/.test(state) ||
      !/^[0-9a-f]{64}$/.test(expected) ||
      !timingSafeEqual(Buffer.from(state, "hex"), Buffer.from(expected, "hex"))) {
    console.error("TikTok callback rejected due to invalid OAuth state.");
    return redirect("invalid-state");
  }
  if (request.nextUrl.searchParams.has("error")) {
    console.error("TikTok authorization was cancelled or rejected.");
    return redirect("cancelled");
  }
  const code = request.nextUrl.searchParams.get("code");
  if (!code) {
    console.error("TikTok callback did not contain an authorization code.");
    return redirect("failed");
  }
  try {
    await connectTikTok(code, config);
    return redirect("connected");
  } catch (error) {
    console.error("TikTok connection failed:", error instanceof TikTokConnectionError ? error.message : "Unexpected server error.");
    return redirect("failed");
  }
}
