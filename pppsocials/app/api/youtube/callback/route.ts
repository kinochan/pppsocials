import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireApiAccess } from "@/src/lib/access";
import { connectYouTube, YouTubeConnectionError, youtubeConfig, youtubeStateCookie } from "@/src/lib/youtube";

export async function GET(request: NextRequest) {
  const denied = await requireApiAccess(request, true);
  if (denied) return denied;
  let config;
  try {
    config = youtubeConfig();
  } catch {
    console.error("YouTube callback configuration is invalid.");
    return NextResponse.json({ message: "YouTube connection is not configured correctly." }, { status: 503 });
  }
  if (!config) return NextResponse.json({ message: "YouTube connection is disabled." }, { status: 503 });

  const redirect = (result: string) => {
    const url = new URL("/settings", config.baseUrl);
    url.searchParams.set("youtube", result);
    const response = NextResponse.redirect(url, 303);
    response.cookies.set(youtubeStateCookie, "", {
      httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0,
    });
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  };

  const state = request.nextUrl.searchParams.get("state");
  const cookie = request.cookies.get(youtubeStateCookie)?.value;
  const parts = cookie?.split(".");
  const expected = parts?.[0];
  const verifier = parts?.[1];
  if (!state || !expected || !verifier || parts?.length !== 2 ||
      !/^[0-9a-f]{64}$/.test(state) || !/^[0-9a-f]{64}$/.test(expected) ||
      !/^[A-Za-z0-9_-]{43}$/.test(verifier) ||
      !timingSafeEqual(Buffer.from(state, "hex"), Buffer.from(expected, "hex"))) {
    console.error("YouTube callback rejected due to invalid OAuth state.");
    return redirect("invalid-state");
  }
  if (request.nextUrl.searchParams.has("error")) {
    console.error("YouTube authorization was cancelled or rejected.");
    return redirect("cancelled");
  }
  const code = request.nextUrl.searchParams.get("code");
  if (!code) {
    console.error("YouTube callback did not contain an authorization code.");
    return redirect("failed");
  }
  try {
    await connectYouTube(code, verifier, config);
    return redirect("connected");
  } catch (error) {
    console.error("YouTube connection failed:", error instanceof YouTubeConnectionError ? error.message : "Unexpected server error.");
    return redirect("failed");
  }
}
