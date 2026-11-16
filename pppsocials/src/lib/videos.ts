import { unlink } from "fs/promises";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import path from "path";
import { db } from "@/src/lib/db";

export interface DuplicateVideo extends RowDataPacket {
  id: string;
  title: string;
  description: string | null;
  filename: string;
  original_filename: string | null;
}

export function validVideoId(id: string) {
  return /^[1-9]\d{0,19}$/.test(id) && BigInt(id) <= BigInt("18446744073709551615");
}

export function validOriginalFilename(filename: string) {
  return filename.length > 0 && Array.from(filename).length <= 255 && !/[/\\\0]/.test(filename);
}

export function safeFilename(filename: string) {
  return filename.replace(/[^\w.-]/g, "_").slice(-180);
}

export function uploadFilePath(storedPath: string) {
  const filename = path.basename(storedPath);
  if (path.dirname(storedPath) !== "uploads" || filename === "." || filename === "..") {
    throw new Error("Invalid stored video path.");
  }
  return path.join(process.cwd(), "uploads", filename);
}

export async function findDuplicates(executor: Pool | PoolConnection, originalFilename: string) {
  const [rows] = await executor.execute<DuplicateVideo[]>(
    `SELECT CAST(id AS CHAR) AS id, title, description, filename, original_filename FROM videos
     WHERE BINARY LOWER(original_filename) = BINARY LOWER(?)
       OR (original_filename IS NULL
         AND filename REGEXP '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}-'
         AND (BINARY LOWER(SUBSTRING(filename, 38)) = BINARY LOWER(?)
           OR BINARY LOWER(SUBSTRING(filename, 38)) = BINARY LOWER(?)))
     ORDER BY id DESC`,
    [originalFilename, safeFilename(originalFilename), safeFilename(Buffer.from(originalFilename, "utf8").toString("latin1"))]
  );
  return rows;
}

export async function withVideoLock<T>(callback: (connection: PoolConnection) => Promise<T>): Promise<T> {
  const connection = await db.getConnection();
  const lockName = "pppsocials-video-modification";
  let locked = false;
  let destroyed = false;
  try {
    const [rows] = await connection.execute<RowDataPacket[]>("SELECT GET_LOCK(?, 10) AS acquired", [lockName]);
    if (rows[0]?.acquired !== 1) throw new Error("Unable to acquire video modification lock.");
    locked = true;
    return await callback(connection);
  } finally {
    if (locked) {
      try {
        await connection.execute("SELECT RELEASE_LOCK(?)", [lockName]);
      } catch (error) {
        console.error("Failed to release video modification lock:", error);
        connection.destroy();
        destroyed = true;
      }
    }
    if (!destroyed) connection.release();
  }
}

export async function removeUnreferencedFile(connection: PoolConnection, storedPath: string) {
  const [rows] = await connection.execute<RowDataPacket[]>(
    "SELECT COUNT(*) AS count FROM videos WHERE BINARY filepath = BINARY ?",
    [storedPath]
  );
  if (Number(rows[0].count) > 0) return;
  try {
    await unlink(uploadFilePath(storedPath));
  } catch (error) {
    console.error("Failed to remove old video file:", error);
    throw error;
  }
}
