import { constants } from "fs";
import { open } from "fs/promises";
import type { ResultSetHeader } from "mysql2";
import { db } from "@/src/lib/db";
import { uploadFilePath } from "@/src/lib/videos";
import { youtubeConfig, youtubePublishingToken, YouTubeConnectionError } from "@/src/lib/youtube";
import { ShortsValidationError, validateYouTubeShort } from "@/src/lib/youtube-short";

export type YouTubePrivacy = "public" | "private" | "unlisted";
export type YouTubePublishInput = {
  id: string;
  channelId: string;
  filepath: string;
  title: string;
  description: string;
  privacy: YouTubePrivacy;
  madeForKids: boolean;
  syntheticMedia: boolean;
};

class UploadError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uploadUrl(location: string | null) {
  if (!location) throw new UploadError("YouTube did not return an upload URL.");
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw new UploadError("YouTube returned an invalid upload URL.");
  }
  if (url.origin !== "https://www.googleapis.com" || url.username || url.password ||
      url.pathname !== "/upload/youtube/v3/videos" || url.hash ||
      url.searchParams.getAll("upload_id").length !== 1 || !url.searchParams.get("upload_id")) {
    throw new UploadError("YouTube returned an invalid upload URL.");
  }
  return url.toString();
}

async function updateProgress(id: string, percent: number) {
  const [result] = await db.execute<ResultSetHeader>(
    `UPDATE youtube_publications SET upload_percent = ?, updated_at = UTC_TIMESTAMP()
     WHERE id = ? AND status = 'uploading' AND active = 1`, [percent, id]
  );
  if (result.affectedRows !== 1) throw new UploadError("The publication is no longer active.");
}

export async function publishYouTubeVideo(input: YouTubePublishInput) {
  let mayHaveUploaded = false;
  let stage = "starting";
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const [claimed] = await db.execute<ResultSetHeader>(
      `UPDATE youtube_publications SET status = 'uploading', updated_at = UTC_TIMESTAMP()
       WHERE id = ? AND status = 'queued' AND active = 1`, [input.id]
    );
    if (claimed.affectedRows !== 1) return;
    stage = "preparing";
    const filepath = uploadFilePath(input.filepath);
    file = await open(filepath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await file.stat();
    if (!stats.isFile() || stats.size <= 0) throw new UploadError("Video file is missing or empty.");
    await updateProgress(input.id, 0);
    await validateYouTubeShort(file, filepath);
    const config = youtubeConfig();
    if (!config) throw new UploadError("YouTube connection is disabled.");
    const token = await youtubePublishingToken(input.channelId, config);
    const response = await fetch(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet%2Cstatus", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Length": String(stats.size),
          "X-Upload-Content-Type": "application/octet-stream",
        },
        body: JSON.stringify({
          snippet: { title: input.title, description: input.description },
          status: {
            privacyStatus: input.privacy,
            selfDeclaredMadeForKids: input.madeForKids,
            containsSyntheticMedia: input.syntheticMedia,
          },
        }),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      }
    );
    if (!response.ok) {
      throw new UploadError(response.status === 401 || response.status === 403
        ? `YouTube rejected the upload (HTTP ${response.status}). Check permission, quota, and channel eligibility; reconnect if needed.`
        : `YouTube could not start the upload (HTTP ${response.status}).`);
    }
    const destination = uploadUrl(response.headers.get("location"));
    stage = "uploading";
    let offset = 0;
    const chunkSize = 8 * 1024 * 1024;
    while (offset < stats.size) {
      const length = Math.min(chunkSize, stats.size - offset);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await file.read(chunk, 0, length, offset);
      if (bytesRead !== length) throw new UploadError("The video file changed during upload.");
      mayHaveUploaded = true;
      const uploaded = await fetch(destination, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(length),
          "Content-Range": `bytes ${offset}-${offset + length - 1}/${stats.size}`,
        },
        body: chunk,
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(45 * 60 * 1000),
      });
      if (uploaded.status === 308) {
        const range = /^bytes=0-(\d+)$/.exec(uploaded.headers.get("range") ?? "");
        const nextOffset = range ? Number(range[1]) + 1 : 0;
        if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset ||
            nextOffset > offset + length || nextOffset >= stats.size) {
          throw new UploadError("YouTube returned an invalid upload progress response.");
        }
        offset = nextOffset;
        await updateProgress(input.id, Math.min(99, Math.floor(offset * 100 / stats.size)));
        continue;
      }
      if (!uploaded.ok) throw new UploadError(`YouTube upload returned HTTP ${uploaded.status}.`);
      const result: unknown = await uploaded.json();
      if (offset + length !== stats.size || !isRecord(result) || typeof result.id !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(result.id)) {
        throw new UploadError("YouTube returned an invalid completed upload.");
      }
      const status = isRecord(result.status) ? result.status : null;
      const actualPrivacy = status && ["public", "private", "unlisted"].includes(String(status.privacyStatus))
        ? String(status.privacyStatus) : null;
      const message = !actualPrivacy ? "Check YouTube Studio for the actual privacy and processing status."
        : actualPrivacy !== input.privacy ? "YouTube returned a different privacy setting. Check YouTube Studio."
          : "Upload accepted. YouTube may still be processing the video.";
      await db.execute(
        `UPDATE youtube_publications SET status = 'uploaded', active = NULL, upload_percent = 100,
         youtube_video_id = ?, actual_privacy = ?, message = ?, updated_at = UTC_TIMESTAMP()
         WHERE id = ? AND status = 'uploading' AND active = 1`,
        [result.id, actualPrivacy, message, input.id]
      );
      return;
    }
    throw new UploadError("YouTube did not confirm the completed upload.");
  } catch (error) {
    const detail = error instanceof UploadError || error instanceof YouTubeConnectionError || error instanceof ShortsValidationError ? error.message
      : error instanceof Error ? error.name : "Unknown error";
    console.error("YouTube upload failed at", stage, detail);
    try {
      await db.execute(
        `UPDATE youtube_publications SET status = ?, active = ?, message = ?, updated_at = UTC_TIMESTAMP()
         WHERE id = ? AND active = 1`,
        [
          mayHaveUploaded ? "unknown" : "failed",
          mayHaveUploaded ? 1 : null,
          mayHaveUploaded
            ? "The upload result is unknown. Check YouTube Studio before trying again."
            : error instanceof UploadError || error instanceof YouTubeConnectionError || error instanceof ShortsValidationError
              ? error.message : "The video could not be uploaded. Check the server logs.",
          input.id,
        ]
      );
    } catch {
      console.error("Could not save YouTube upload status. Check the database.");
    }
  } finally {
    if (file) await file.close();
  }
}
