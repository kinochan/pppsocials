import { createHash } from "crypto";
import type { RowDataPacket } from "mysql2";
import { db } from "@/src/lib/db";

export async function withAuthLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const name = `pppa_${createHash("sha256").update(key).digest("hex").slice(0, 55)}`;
  const connection = await db.getConnection();
  let destroyed = false;
  try {
    const [rows] = await connection.query<RowDataPacket[]>("SELECT GET_LOCK(?, 10) AS acquired", [name]);
    if (rows[0]?.acquired !== 1) throw new Error("Authentication lock unavailable.");
    try {
      return await operation();
    } finally {
      try {
        const [released] = await connection.query<RowDataPacket[]>("SELECT RELEASE_LOCK(?) AS released", [name]);
        if (released[0]?.released !== 1) throw new Error("Authentication lock could not be released.");
      } catch (error) {
        connection.destroy();
        destroyed = true;
        throw error;
      }
    }
  } finally {
    if (!destroyed) connection.release();
  }
}
