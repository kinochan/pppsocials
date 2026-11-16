import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { connectInstagram, InstagramConnectionError, instagramConfig, stateCookie } from "@/src/lib/instagram";

export async function GET(request: NextRequest) {
  let config;
  try {
    config = instagramConfig();
  } catch {
    console.error("Instagram callback configuration is invalid.");
    return NextResponse.json({ message: "Instagram connection is not configured correctly." }, { status: 503 });
  }
  if (!config) {
    return NextResponse.json({ message: "Instagram connection is disabled." }, { status: 503 });
  }

  const redirect = (result: string) => {
    const url = new URL("/settings", config.baseUrl);
    url.searchParams.set("instagram", result);
    const response = NextResponse.redirect(url, 303);
    response.cookies.set(stateCookie, "", {
      httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0,
    });
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  };

  const state = request.nextUrl.searchParams.get("state");
  const expected = request.cookies.get(stateCookie)?.value;
  if (!state || !expected || !/^[0-9a-f]{64}$/.test(state) ||
      !/^[0-9a-f]{64}$/.test(expected) ||
      !timingSafeEqual(Buffer.from(state, "hex"), Buffer.from(expected, "hex"))) {
    console.error("Instagram callback rejected due to invalid OAuth state.");
    return redirect("invalid-state");
  }
  if (request.nextUrl.searchParams.has("error")) {
    console.error("Meta authorization was cancelled or rejected.");
    return redirect("cancelled");
  }
  const code = request.nextUrl.searchParams.get("code");
  if (!code) {
    console.error("Instagram callback did not contain an authorization code.");
    return redirect("failed");
  }

  try {
    await connectInstagram(code, config);
    return redirect("connected");
  } catch (error) {
    console.error("Instagram connection failed:", error instanceof InstagramConnectionError ? error.message : "Unexpected server error.");
    return redirect("failed");
  }
}
