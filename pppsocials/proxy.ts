import { NextRequest, NextResponse } from "next/server";
import { currentUser, requireApiAccess } from "@/src/lib/access";
import { publicOrigin } from "@/src/lib/auth";

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (pathname === "/login" || pathname === "/setup" ||
      /^\/(tos|policy)\/?$/.test(pathname) ||
      pathname === "/api/setup" || pathname.startsWith("/api/auth/") ||
      /^\/api\/tiktok-media\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pathname)) {
    return NextResponse.next();
  }
  const adminOnly = pathname === "/settings" || pathname.startsWith("/settings/") ||
    pathname === "/users" || pathname.startsWith("/users/") ||
    /^\/api\/(facebook|instagram|tiktok|youtube|users)(\/|$)/.test(pathname);
  if (pathname.startsWith("/api/")) {
    return (await requireApiAccess(request, adminOnly)) ?? NextResponse.next();
  }
  try {
    const user = await currentUser(request.headers);
    if (!user) return NextResponse.redirect(new URL("/login", publicOrigin()));
    if (adminOnly && user.role !== "admin") return NextResponse.redirect(new URL("/", publicOrigin()));
    return NextResponse.next();
  } catch (error) {
    console.error("Authentication check failed:", error);
    return new NextResponse("Authentication is unavailable.", { status: 503 });
  }
}

export const config = {
  matcher: ["/((?!api/upload/?$|_next/static|_next/image|favicon.ico).*)"],
};
