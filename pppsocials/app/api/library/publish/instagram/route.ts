import { after } from "next/server";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { requireApiAccess } from "@/src/lib/access";
import { db } from "@/src/lib/db";
import { instagramConfig, instagramPublishingConnection, savedInstagramAccounts } from "@/src/lib/instagram";
import { publishInstagramStory } from "@/src/lib/instagram-publish";
import { validVideoId } from "@/src/lib/videos";

export const maxDuration = 3600;

interface VideoRow extends RowDataPacket {
  filename: string;
  filepath: string;
}

interface PublicationRow extends RowDataPacket {
  id: string;
  accountId: string;
  username: string;
  status: string;
  mediaType: string;
  uploadPercent: number | null;
  message: string | null;
  mediaId: string | null;
  createdAt: string;
  canResolve: number;
}

async function readInput(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.body || !request.headers.get("content-type")?.startsWith("application/json")) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16384) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  const videoId = new URL(request.url).searchParams.get("video");
  if (!videoId || !validVideoId(videoId)) return Response.json({ message: "Invalid video." }, { status: 400 });
  try {
    const config = instagramConfig();
    const accounts = config ? await savedInstagramAccounts() : null;
    const [publications] = await db.execute<PublicationRow[]>(
      `SELECT id, account_id AS accountId, username, status, message, media_id AS mediaId,
       media_type AS mediaType, upload_percent AS uploadPercent,
       DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS createdAt,
       (status = 'unknown' OR (active = 1 AND updated_at < UTC_TIMESTAMP() - INTERVAL 90 MINUTE)) AS canResolve
       FROM instagram_publications WHERE video_id = ? ORDER BY active DESC, created_at DESC, id DESC LIMIT 50`,
      [videoId]
    );
    return Response.json({ enabled: !!config, accounts: accounts ?? [], publications }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    console.error("Could not load Instagram publishing information. Check configuration and database.");
    return Response.json({ message: "Unable to load Instagram publishing information." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  const input = await readInput(request);
  if (!input || typeof input.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.id) ||
      typeof input.videoId !== "string" || !validVideoId(input.videoId) ||
      typeof input.filename !== "string" || !input.filename ||
      typeof input.accountId !== "string" || !/^\d{1,191}$/.test(input.accountId) ||
      input.mediaType !== "STORIES") {
    return Response.json({ message: "Invalid publishing request. Refresh the page and try again." }, { status: 400 });
  }
  try {
    const config = instagramConfig();
    if (!config) return Response.json({ message: "Instagram connection is disabled." }, { status: 503 });
    const connection = await instagramPublishingConnection(config.key);
    const account = connection?.accounts.find((item) => item.id === input.accountId);
    if (!connection || !account) return Response.json({ message: "Instagram account is not connected." }, { status: 400 });
    const [videos] = await db.execute<VideoRow[]>("SELECT filename, filepath FROM videos WHERE id = ?", [input.videoId]);
    if (!videos.length || videos[0].filename !== input.filename) {
      return Response.json({ message: "The video changed. Refresh the library and try again." }, { status: 409 });
    }
    try {
      await db.execute(
        `INSERT INTO instagram_publications
         (id, video_id, account_id, username, status, media_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', 'STORIES', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
        [input.id, input.videoId, account.id, account.username]
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ER_DUP_ENTRY") {
        return Response.json({ message: "A request with this ID or an active publication already exists. Refresh the status before retrying." }, { status: 409 });
      }
      throw error;
    }
    const job = {
      id: input.id,
      accountId: account.id,
      filepath: videos[0].filepath,
      token: connection.token,
    };
    after(() => publishInstagramStory(job));
    return Response.json({ id: input.id }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("Could not start Instagram publication. Check configuration and database.");
    return Response.json({ message: "Unable to start publishing. Refresh the status before retrying." }, { status: 503 });
  }
}

export async function PATCH(request: Request) {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  const input = await readInput(request);
  if (!input || typeof input.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.id) ||
      input.confirm !== true) {
    return Response.json({ message: "Invalid status resolution request." }, { status: 400 });
  }
  try {
    const [result] = await db.execute<ResultSetHeader>(
      `UPDATE instagram_publications SET status = 'resolved', active = NULL,
       message = 'Manually resolved after checking Instagram.', updated_at = UTC_TIMESTAMP()
       WHERE id = ? AND active = 1 AND
         (status = 'unknown' OR updated_at < UTC_TIMESTAMP() - INTERVAL 90 MINUTE)`,
      [input.id]
    );
    if (!result.affectedRows) return Response.json({ message: "This publication cannot be resolved yet." }, { status: 409 });
    return Response.json({ success: true });
  } catch {
    console.error("Could not resolve Instagram publishing status. Check the database.");
    return Response.json({ message: "Unable to resolve publishing status." }, { status: 503 });
  }
}
