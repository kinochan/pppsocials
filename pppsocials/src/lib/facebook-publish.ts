import { constants } from "fs";
import { open } from "fs/promises";
import type { ResultSetHeader } from "mysql2";
import { db } from "@/src/lib/db";
import { metaJson, PublishError, uploadMetaVideo } from "@/src/lib/meta-publish";
import { uploadFilePath } from "@/src/lib/videos";

type PublishInput = {
  id: string;
  pageId: string;
  filepath: string;
  token: string;
};

async function transition(id: string, from: string, to: string, metaVideoId?: string) {
  const [result] = await db.execute<ResultSetHeader>(
    `UPDATE facebook_publications SET status = ?, meta_video_id = COALESCE(?, meta_video_id),
       updated_at = UTC_TIMESTAMP() WHERE id = ? AND status = ? AND active = 1`,
    [to, metaVideoId ?? null, id, from]
  );
  return result.affectedRows === 1;
}

async function updateUploadProgress(id: string, percent: number) {
  const [result] = await db.execute<ResultSetHeader>(
    `UPDATE facebook_publications SET upload_percent = ?, updated_at = UTC_TIMESTAMP()
     WHERE id = ? AND status = 'uploading' AND active = 1`,
    [percent, id]
  );
  if (result.affectedRows !== 1) throw new PublishError("The publication is no longer active.");
}

export async function publishFacebookStory(input: PublishInput) {
  let mayHavePublished = false;
  let stage = "starting";
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!await transition(input.id, "queued", "uploading")) return;
    stage = "uploading";
    file = await open(uploadFilePath(input.filepath), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await file.stat();
    if (!stats.isFile() || stats.size <= 0) throw new PublishError("Video file is missing or empty.");
    await updateUploadProgress(input.id, 0);

    const graph = "https://graph.facebook.com/v27.0";
    const storyUrl = `${graph}/${encodeURIComponent(input.pageId)}/video_stories`;
    const headers = { Authorization: `Bearer ${input.token}`, "Content-Type": "application/x-www-form-urlencoded" };
    const started = await metaJson(storyUrl, {
      method: "POST",
      headers,
      body: new URLSearchParams({ upload_phase: "start" }),
      signal: AbortSignal.timeout(30000),
    });
    if (typeof started.video_id !== "string" || !/^\d{1,191}$/.test(started.video_id)) {
      throw new PublishError("Meta did not return a valid video ID.");
    }
    const metaVideoId = started.video_id;
    const expectedUploadUrl = `https://rupload.facebook.com/video-upload/v27.0/${metaVideoId}`;
    if (started.upload_url !== expectedUploadUrl) {
      throw new PublishError("Meta returned an invalid upload URL.");
    }
    if (!await transition(input.id, "uploading", "uploading", metaVideoId)) return;
    await uploadMetaVideo(file, stats.size, expectedUploadUrl, input.token,
      (percent) => updateUploadProgress(input.id, percent));

    if (!await transition(input.id, "uploading", "publishing")) return;
    mayHavePublished = true;
    stage = "publishing";
    const result = await metaJson(storyUrl, {
      method: "POST",
      headers,
      body: new URLSearchParams({ upload_phase: "finish", video_id: metaVideoId }),
      signal: AbortSignal.timeout(30000),
    });
    if (result.success !== true) throw new PublishError("Meta did not confirm the Story publication.");
    const postId = typeof result.post_id === "string" && /^[0-9_]{1,191}$/.test(result.post_id)
      ? result.post_id
      : typeof result.post_id === "number" && Number.isSafeInteger(result.post_id) && result.post_id > 0
        ? String(result.post_id) : null;
    await db.execute(
      `UPDATE facebook_publications SET status = 'published', active = NULL, post_id = ?, message = ?,
       updated_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'publishing' AND active = 1`,
      [postId, postId ? null : "Meta confirmed publication but did not return a usable post ID.", input.id]
    );
  } catch (error) {
    const detail = error instanceof PublishError ? error.message
      : error instanceof Error ? error.name : "Unknown error";
    console.error("Facebook Story publishing failed at", stage, detail);
    try {
      await db.execute(
        `UPDATE facebook_publications SET status = ?, active = ?, message = ?, updated_at = UTC_TIMESTAMP()
         WHERE id = ? AND active = 1`,
        [
          mayHavePublished ? "unknown" : "failed",
          mayHavePublished ? 1 : null,
          mayHavePublished
            ? "The publish result is unknown. Check the Facebook Page before trying again."
            : error instanceof PublishError ? error.message : "The video could not be uploaded. Check the server logs.",
          input.id,
        ]
      );
    } catch {
      console.error("Could not save Facebook publishing status. Check the database.");
    }
  } finally {
    if (file) await file.close();
  }
}
