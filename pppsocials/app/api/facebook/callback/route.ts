import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireApiAccess } from "@/src/lib/access";
import { connectFacebook, FacebookConnectionError, facebookConfig, facebookStateCookie } from "@/src/lib/facebook";

export async function GET(request: NextRequest) {
  const denied = await requireApiAccess(request, true);
  if (denied) return denied;
  let config;
  try {
    config = facebookConfig();
  } catch {
    console.error("Facebook callback configuration is invalid.");
    return NextResponse.json({ message: "Facebook connection is not configured correctly." }, { status: 503 });
  }
  if (!config) return NextResponse.json({ message: "Facebook connection is disabled." }, { status: 503 });

  const redirect = (result: string) => {
    const url = new URL("/settings", config.baseUrl);
    url.searchParams.set("facebook", result);
    const response = NextResponse.redirect(url, 303);
    response.cookies.set(facebookStateCookie, "", {
      httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0,
    });
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  };

  const state = request.nextUrl.searchParams.get("state");
  const expected = request.cookies.get(facebookStateCookie)?.value;
  if (!state || !expected || !/^[0-9a-f]{64}$/.test(state) ||
      !/^[0-9a-f]{64}$/.test(expected) ||
      !timingSafeEqual(Buffer.from(state, "hex"), Buffer.from(expected, "hex"))) {
    console.error("Facebook callback rejected due to invalid OAuth state.");
    return redirect("invalid-state");
  }
  if (request.nextUrl.searchParams.has("error")) {
    console.error("Facebook authorization was cancelled or rejected.");
    return redirect("cancelled");
  }
  const code = request.nextUrl.searchParams.get("code");
  if (!code) {
    console.error("Facebook callback did not contain an authorization code.");
    return redirect("failed");
  }
  try {
    await connectFacebook(code, config);
    return redirect("connected");
  } catch (error) {
    console.error("Facebook connection failed:", error instanceof FacebookConnectionError ? error.message : "Unexpected server error.");
    return redirect("failed");
  }
}
