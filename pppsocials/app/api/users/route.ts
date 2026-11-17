import { NextResponse } from "next/server";
import { requireApiAccess } from "@/src/lib/access";
import { getAuth } from "@/src/lib/auth";
import { readAuthInput, validCredentials } from "@/src/lib/auth-input";
import { withAuthLock } from "@/src/lib/auth-lock";

export async function GET(request: Request) {
  const denied = await requireApiAccess(request, true);
  if (denied) return denied;
  try {
    const offset = Number(new URL(request.url).searchParams.get("offset") ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      return NextResponse.json({ message: "Invalid page." }, { status: 400 });
    }
    const result = await getAuth().api.listUsers({ headers: request.headers, query: { limit: 50, offset } });
    return NextResponse.json({
      users: result.users.map(({ id, email, role, banned }) => ({ id, email, role, banned })),
      total: result.total,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Could not load users:", error);
    return NextResponse.json({ message: "Unable to load users." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const denied = await requireApiAccess(request, true);
  if (denied) return denied;
  const body = await readAuthInput(request);
  if (!body) return NextResponse.json({ message: "Invalid request." }, { status: 400 });
  const auth = getAuth();
  try {
    if (body.action === "create") {
      if (typeof body.email !== "string" || typeof body.password !== "string" ||
          !validCredentials(body.email, body.password) || (body.role !== "user" && body.role !== "admin")) {
        return NextResponse.json({ message: "Enter a valid email and a password of 12 to 128 characters." }, { status: 400 });
      }
      await auth.api.createUser({
        headers: request.headers,
        body: { email: body.email, password: body.password, name: body.email, role: body.role },
      });
      return NextResponse.json({ message: "User created." });
    }
    if (typeof body.userId !== "string" || body.userId.length > 64 || !body.userId) {
      return NextResponse.json({ message: "Invalid user." }, { status: 400 });
    }
    if (body.action === "reset") {
      if (typeof body.password !== "string" || body.password.length < 12 || body.password.length > 128) {
        return NextResponse.json({ message: "The password must be 12 to 128 characters." }, { status: 400 });
      }
      const userId = body.userId;
      const password = body.password;
      const target = await auth.api.getUser({ headers: request.headers, query: { id: userId } });
      await withAuthLock(target.email.toLowerCase(), async () => {
        await auth.api.setUserPassword({ headers: request.headers, body: { userId, newPassword: password } });
        await auth.api.revokeUserSessions({ headers: request.headers, body: { userId } });
      });
      return NextResponse.json({ message: "Password reset and sessions revoked." });
    }
    if (body.action === "disable" || body.action === "enable") {
      const target = await auth.api.getUser({ headers: request.headers, query: { id: body.userId } });
      if (target.role !== "user") {
        return NextResponse.json({ message: "Administrator accounts cannot be disabled here." }, { status: 400 });
      }
      if (body.action === "disable") {
        const userId = body.userId;
        await withAuthLock(target.email.toLowerCase(), async () => {
          await auth.api.banUser({ headers: request.headers, body: { userId } });
        });
      } else {
        await auth.api.unbanUser({ headers: request.headers, body: { userId: body.userId } });
      }
      return NextResponse.json({ message: body.action === "disable" ? "User disabled." : "User enabled." });
    }
    return NextResponse.json({ message: "Invalid action." }, { status: 400 });
  } catch (error) {
    console.error("User administration failed:", error instanceof Error ? error.message : "Unexpected error.");
    return NextResponse.json({ message: "Unable to update the user. Check the email and try again." }, { status: 500 });
  }
}
