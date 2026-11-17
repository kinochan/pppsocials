import { constants } from "fs";
import { open } from "fs/promises";
import path from "path";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { db } from "@/src/lib/db";
import { tiktokConfig, tiktokUploadToken, TikTokConnectionError } from "@/src/lib/tiktok";
import { uploadFilePath } from "@/src/lib/videos";

export class TikTokUploadError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function apiRequest(endpoint: string, token: string, body: object) {
  const response = await fetch(`https://open.tiktokapis.com/v2/post/publish/${endpoint}/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(body), redirect: "error", cache: "no-store",
    signal: AbortSignal.timeout(30000),
  });
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new TikTokUploadError(`TikTok returned an invalid response (HTTP ${response.status}).`);
  }
  if (!response.ok || !isRecord(result) || !isRecord(result.error) || result.error.code !== "ok") {
    const code = isRecord(result) && isRecord(result.error) && typeof result.error.code === "string" &&
      /^[a-z0-9_]{1,80}$/.test(result.error.code) ? result.error.code : "unknown";
    throw new TikTokUploadError(`TikTok request failed (HTTP ${response.status}, ${code}).`);
  }
  if (!isRecord(result.data)) throw new TikTokUploadError("TikTok returned an invalid response.");
  return result.data;
}

function safeUploadUrl(value: unknown) {
  if (typeof value !== "string") throw new TikTokUploadError("TikTok did not return an upload URL.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TikTokUploadError("TikTok returned an invalid upload URL.");
  }
  if (url.protocol !== "https:" || !["open-upload.tiktokapis.com", "upload.us.tiktokapis.com"].includes(url.hostname) ||
      url.port || url.username || url.password || url.hash || !["/video/", "/upload/"].includes(url.pathname) ||
      url.searchParams.getAll("upload_id").length !== 1 || !url.searchParams.get("upload_id") ||
      url.searchParams.getAll("upload_token").length !== 1 || !url.searchParams.get("upload_token")) {
    throw new TikTokUploadError("TikTok returned an invalid upload URL.");
  }
  return url.toString();
}

export async function uploadTikTokDraft(input: { id: string; accountId: string; filepath: string }) {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let transferStarted = false;
  try {
    const [claimed] = await db.execute<ResultSetHeader>(
      "UPDATE tiktok_uploads SET status = 'uploading', updated_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'queued' AND active = 1",
      [input.id]
    );
    if (claimed.affectedRows !== 1) return;
    const filepath = uploadFilePath(input.filepath);
    const types: Record<string, string> = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm" };
    const contentType = types[path.extname(filepath).toLowerCase()];
    if (!contentType) throw new TikTokUploadError("TikTok accepts MP4, MOV, or WebM videos.");
    file = await open(filepath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await file.stat();
    if (!stats.isFile() || !stats.size || stats.size > 4_000_000_000) {
      throw new TikTokUploadError("The video is missing, empty, or exceeds TikTok's 4 GB limit.");
    }
    const config = tiktokConfig();
    if (!config?.uploadEnabled) throw new TikTokUploadError("TikTok uploads are disabled.");
    const token = await tiktokUploadToken(input.accountId, config);
    const chunkSize = stats.size <= 64_000_000 ? stats.size : 10_000_000;
    const count = Math.floor(stats.size / chunkSize);
    const init = await apiRequest("inbox/video/init", token, {
      source_info: { source: "FILE_UPLOAD", video_size: stats.size, chunk_size: chunkSize, total_chunk_count: count },
    });
    if (typeof init.publish_id !== "string" || !/^[A-Za-z0-9_~.-]{1,64}$/.test(init.publish_id)) {
      throw new TikTokUploadError("TikTok returned an invalid upload ID.");
    }
    const destination = safeUploadUrl(init.upload_url);
    const [prepared] = await db.execute<ResultSetHeader>(
      "UPDATE tiktok_uploads SET publish_id = ?, upload_percent = 0, updated_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'uploading' AND active = 1",
      [init.publish_id, input.id]
    );
    if (prepared.affectedRows !== 1) throw new TikTokUploadError("The upload is no longer active.");
    let offset = 0;
    for (let index = 0; index < count; index++) {
      const length = index === count - 1 ? stats.size - offset : chunkSize;
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await file.read(chunk, 0, length, offset);
      if (bytesRead !== length) throw new TikTokUploadError("The video file changed during upload.");
      transferStarted = true;
      const response = await fetch(destination, {
        method: "PUT",
        headers: { "Content-Type": contentType, "Content-Length": String(length),
          "Content-Range": `bytes ${offset}-${offset + length - 1}/${stats.size}` },
        body: chunk, redirect: "error", cache: "no-store",
        signal: AbortSignal.timeout(15 * 60 * 1000),
      });
      if (response.status !== (index === count - 1 ? 201 : 206)) {
        throw new TikTokUploadError(`TikTok upload returned HTTP ${response.status}.`);
      }
      offset += length;
      const [updated] = await db.execute<ResultSetHeader>(
        `UPDATE tiktok_uploads SET upload_percent = ?, updated_at = UTC_TIMESTAMP()
         WHERE id = ? AND status = 'uploading' AND active = 1`,
        [Math.floor(offset * 100 / stats.size), input.id]
      );
      if (updated.affectedRows !== 1) throw new TikTokUploadError("The upload is no longer active.");
    }
    await db.execute(
      `UPDATE tiktok_uploads SET status = 'processing', message = 'Upload sent. Check status for TikTok inbox delivery.',
       updated_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'uploading' AND active = 1`, [input.id]
    );
  } catch (error) {
    const message = error instanceof TikTokUploadError || error instanceof TikTokConnectionError
      ? error.message : "The upload could not be completed. Check the server logs.";
    console.error("TikTok upload failed:", error instanceof TikTokUploadError || error instanceof TikTokConnectionError
      ? error.message : error instanceof Error ? error.name : "Unknown error");
    try {
      await db.execute(
        "UPDATE tiktok_uploads SET status = ?, active = ?, message = ?, updated_at = UTC_TIMESTAMP() WHERE id = ? AND active = 1",
        [transferStarted ? "unknown" : "failed", transferStarted ? 1 : null,
          transferStarted ? "Upload result uncertain. Check status and the TikTok inbox before retrying." : message, input.id]
      );
    } catch {
      console.error("Could not save TikTok upload status. Check the database.");
    }
  } finally {
    if (file) await file.close();
  }
}

interface StatusRow extends RowDataPacket {
  account_id: string;
  publish_id: string | null;
}

export async function checkTikTokUpload(id: string) {
  const [rows] = await db.execute<StatusRow[]>(
    "SELECT account_id, publish_id FROM tiktok_uploads WHERE id = ? AND active = 1 AND status IN ('processing', 'unknown')", [id]
  );
  if (!rows.length || !rows[0].publish_id) throw new TikTokUploadError("This upload cannot be checked yet.");
  const config = tiktokConfig();
  if (!config?.uploadEnabled) throw new TikTokUploadError("TikTok uploads are disabled.");
  const token = await tiktokUploadToken(rows[0].account_id, config);
  const data = await apiRequest("status/fetch", token, { publish_id: rows[0].publish_id });
  let status: string;
  let active: number | null;
  let message: string;
  switch (data.status) {
    case "PROCESSING_UPLOAD":
    case "PROCESSING_DOWNLOAD":
      status = "processing"; active = 1; message = "TikTok is processing the upload."; break;
    case "SEND_TO_USER_INBOX":
      status = "delivered"; active = null; message = "Open the TikTok inbox notification to edit and post the video."; break;
    case "PUBLISH_COMPLETE":
      status = "published"; active = null; message = "TikTok reports that the video was posted."; break;
    case "FAILED": {
      const reason = typeof data.fail_reason === "string" && /^[a-z0-9_]{1,80}$/.test(data.fail_reason)
        ? data.fail_reason : "unknown";
      status = "failed"; active = null; message = `TikTok could not process the upload (${reason}).`; break;
    }
    default:
      throw new TikTokUploadError("TikTok returned an unrecognized upload status.");
  }
  const [updated] = await db.execute<ResultSetHeader>(
    `UPDATE tiktok_uploads SET status = ?, active = ?, message = ?, updated_at = UTC_TIMESTAMP()
     WHERE id = ? AND active = 1 AND status IN ('processing', 'unknown')`,
    [status, active, message, id]
  );
  if (!updated.affectedRows) throw new TikTokUploadError("The upload status changed. Refresh and try again.");
}
