import { createHash, timingSafeEqual } from "crypto";
import type { RowDataPacket } from "mysql2";
import { NextResponse } from "next/server";
import { getAuth, publicOrigin } from "@/src/lib/auth";
import { readAuthInput, validCredentials } from "@/src/lib/auth-input";
import { db } from "@/src/lib/db";

export async function POST(request: Request) {
  try {
    if (request.headers.get("origin") !== publicOrigin()) {
      return NextResponse.json({ message: "Invalid request origin." }, { status: 403 });
    }
    const secret = process.env.AUTH_SETUP_SECRET;
    if (!secret || !/^[0-9a-f]{64}$/i.test(secret)) {
      return NextResponse.json({ message: "Setup is disabled." }, { status: 403 });
    }
    const body = await readAuthInput(request);
    if (!body || typeof body.secret !== "string" || body.secret.length > 128 ||
        typeof body.email !== "string" || typeof body.password !== "string" ||
        !validCredentials(body.email, body.password)) {
      return NextResponse.json({ message: "Invalid setup details." }, { status: 400 });
    }
    const digest = (value: string) => createHash("sha256").update(value).digest();
    if (!timingSafeEqual(digest(body.secret), digest(secret))) {
      return NextResponse.json({ message: "Invalid setup details." }, { status: 403 });
    }
    const connection = await db.getConnection();
    try {
      const [locks] = await connection.query<RowDataPacket[]>("SELECT GET_LOCK('pppsocials_auth_setup', 10) AS acquired");
      if (locks[0]?.acquired !== 1) {
        return NextResponse.json({ message: "Setup is temporarily unavailable." }, { status: 503 });
      }
      try {
        const [rows] = await connection.query<RowDataPacket[]>("SELECT COUNT(*) AS count FROM auth_user");
        if (Number(rows[0].count) !== 0) {
          return NextResponse.json({ message: "Setup has already been completed." }, { status: 403 });
        }
        await getAuth().api.createUser({ body: { email: body.email, password: body.password, name: "Administrator", role: "admin" } });
        return NextResponse.json({ message: "Administrator created. You can now sign in." });
      } finally {
        try {
          await connection.query("SELECT RELEASE_LOCK('pppsocials_auth_setup')");
        } catch (error) {
          connection.destroy();
          throw error;
        }
      }
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error("Administrator setup failed:", error);
    return NextResponse.json({ message: "Setup failed. Check the server configuration and database." }, { status: 503 });
  }
}
