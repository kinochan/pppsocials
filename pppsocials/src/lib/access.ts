import { NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { getAuth, publicOrigin } from "@/src/lib/auth";

export async function currentUser(headers: Headers) {
  if (!getSessionCookie(headers)) return null;
  const session = await getAuth().api.getSession({
    headers,
    query: { disableCookieCache: true, disableRefresh: true },
  });
  if (!session || session.user.banned) return null;
  return session.user;
}

export async function requireApiAccess(request: Request, adminOnly = false) {
  const headers = request.headers;
  const method = request.method;
  try {
    if (!["GET", "HEAD", "OPTIONS"].includes(method) &&
        headers.get("origin") !== publicOrigin()) {
      return NextResponse.json({ message: "Invalid request origin." }, { status: 403 });
    }
    const user = await currentUser(headers);
    if (!user) return NextResponse.json({ message: "Please sign in." }, { status: 401 });
    if (adminOnly && user.role !== "admin") {
      return NextResponse.json({ message: "Administrator access required." }, { status: 403 });
    }
    return null;
  } catch (error) {
    console.error("Authentication check failed:", error);
    return NextResponse.json({ message: "Authentication is unavailable." }, { status: 503 });
  }
}
