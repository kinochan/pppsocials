import { after } from "next/server";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { requireApiAccess } from "@/src/lib/access";
import { readAuthInput } from "@/src/lib/auth-input";
import { db } from "@/src/lib/db";
import { savedTikTokAccounts, tiktokConfig, TikTokConnectionError } from "@/src/lib/tiktok";
import { checkTikTokUpload, TikTokUploadError, uploadTikTokDraft } from "@/src/lib/tiktok-upload";
import { validVideoId } from "@/src/lib/videos";

export const maxDuration = 3600;

interface VideoRow extends RowDataPacket {
  filename: string;
  filepath: string;
}

interface UploadRow extends RowDataPacket {
  id: string;
  accountName: string;
  status: string;
  uploadPercent: number | null;
  message: string | null;
  createdAt: string;
  canCheck: number;
  canResolve: number;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  const videoId = new URL(request.url).searchParams.get("video");
  if (!videoId || !validVideoId(videoId)) return Response.json({ message: "Invalid video." }, { status: 400 });
  try {
    const config = tiktokConfig();
    const accounts = config?.uploadEnabled ? await savedTikTokAccounts() : [];
    const [uploads] = await db.execute<UploadRow[]>(
      `SELECT id, account_name AS accountName, status, upload_percent AS uploadPercent, message,
       DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS createdAt,
       (active = 1 AND status IN ('processing', 'unknown') AND publish_id IS NOT NULL) AS canCheck,
       (status = 'unknown' OR (active = 1 AND updated_at < UTC_TIMESTAMP() - INTERVAL 90 MINUTE)) AS canResolve
       FROM tiktok_uploads WHERE video_id = ? ORDER BY active DESC, created_at DESC, id DESC LIMIT 50`, [videoId]
    );
    return Response.json({ enabled: !!config?.uploadEnabled, accounts, uploads }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("Could not load TikTok uploads. Check configuration and database.");
    return Response.json({ message: "Unable to load TikTok uploads." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  const input = await readAuthInput(request);
  if (!input || typeof input.id !== "string" || !uuid.test(input.id) ||
      typeof input.videoId !== "string" || !validVideoId(input.videoId) ||
      typeof input.filename !== "string" || !input.filename ||
      typeof input.accountId !== "string" || !input.accountId || Array.from(input.accountId).length > 191 ||
      input.confirm !== true) {
    return Response.json({ message: "Invalid TikTok upload request." }, { status: 400 });
  }
  try {
    if (!tiktokConfig()?.uploadEnabled) return Response.json({ message: "TikTok uploads are disabled." }, { status: 503 });
    const accounts = await savedTikTokAccounts();
    const account = accounts.find((item) => item.id === input.accountId);
    if (!account) return Response.json({ message: "TikTok account is not connected." }, { status: 400 });
    const [videos] = await db.execute<VideoRow[]>("SELECT filename, filepath FROM videos WHERE id = ?", [input.videoId]);
    if (!videos.length || videos[0].filename !== input.filename) {
      return Response.json({ message: "The video changed. Refresh the library and try again." }, { status: 409 });
    }
    try {
      await db.execute(
        `INSERT INTO tiktok_uploads (id, video_id, account_id, account_name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
        [input.id, input.videoId, account.id, account.displayName]
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ER_DUP_ENTRY") {
        return Response.json({ message: "An active upload or request with this ID already exists. Refresh the status." }, { status: 409 });
      }
      throw error;
    }
    const job = { id: input.id, accountId: account.id, filepath: videos[0].filepath };
    after(() => uploadTikTokDraft(job));
    return Response.json({ id: input.id }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("Could not start TikTok upload. Check configuration and database.");
    return Response.json({ message: "Unable to start the upload. Refresh the status before retrying." }, { status: 503 });
  }
}

export async function PATCH(request: Request) {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  const input = await readAuthInput(request);
  if (!input || typeof input.id !== "string" || !uuid.test(input.id) ||
      (input.action !== "check" && (input.action !== "resolve" || input.confirm !== true))) {
    return Response.json({ message: "Invalid TikTok status request." }, { status: 400 });
  }
  try {
    if (input.action === "check") {
      await checkTikTokUpload(input.id);
    } else {
      const [result] = await db.execute<ResultSetHeader>(
        `UPDATE tiktok_uploads SET status = 'resolved', active = NULL,
         message = 'Manually resolved after checking TikTok.', updated_at = UTC_TIMESTAMP()
         WHERE id = ? AND active = 1 AND
         (status = 'unknown' OR updated_at < UTC_TIMESTAMP() - INTERVAL 90 MINUTE)`, [input.id]
      );
      if (!result.affectedRows) return Response.json({ message: "This upload cannot be resolved yet." }, { status: 409 });
    }
    return Response.json({ success: true });
  } catch (error) {
    console.error("Could not update TikTok upload status:", error instanceof Error ? error.name : "Unknown error");
    const message = error instanceof TikTokConnectionError || error instanceof TikTokUploadError
      ? error.message : "Unable to update TikTok upload status. Check the server logs.";
    return Response.json({ message }, { status: 503 });
  }
}
