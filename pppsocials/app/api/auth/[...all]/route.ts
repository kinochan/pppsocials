import { getAuth, publicOrigin } from "@/src/lib/auth";
import { readAuthInput, validCredentials } from "@/src/lib/auth-input";
import { withAuthLock } from "@/src/lib/auth-lock";
import { NextResponse } from "next/server";

const allowed = new Set(["/api/auth/sign-in/email", "/api/auth/sign-out", "/api/auth/get-session"]);

async function handle(request: Request) {
  if (!allowed.has(new URL(request.url).pathname)) {
    return NextResponse.json({ message: "Not found." }, { status: 404 });
  }
  try {
    if (request.method === "POST" && request.headers.get("origin") !== publicOrigin()) {
      return NextResponse.json({ message: "Invalid request origin." }, { status: 403 });
    }
    if (new URL(request.url).pathname === "/api/auth/sign-in/email" && request.method === "POST") {
      const body = await readAuthInput(request);
      if (!body || typeof body.email !== "string" || typeof body.password !== "string" ||
          !validCredentials(body.email, body.password)) {
        return NextResponse.json({ message: "Invalid email or password." }, { status: 400 });
      }
      const email = body.email.toLowerCase();
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      const sanitized = new Request(request.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ email, password: body.password, rememberMe: false }),
      });
      return await withAuthLock(email, () => getAuth().handler(sanitized));
    }
    return await getAuth().handler(request);
  } catch (error) {
    console.error("Authentication request failed:", error instanceof Error ? error.message : "Unexpected error.");
    return NextResponse.json({ message: "Authentication is unavailable." }, { status: 503 });
  }
}

export const GET = handle;
export const POST = handle;
