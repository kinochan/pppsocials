import { constants } from "fs";
import { open } from "fs/promises";
import type { ResultSetHeader } from "mysql2";
import { db } from "@/src/lib/db";
import { uploadFilePath } from "@/src/lib/videos";
import { metaJson, PublishError, uploadMetaVideo } from "@/src/lib/meta-publish";

type PublishInput = {
  id: string;
  accountId: string;
  filepath: string;
  token: string;
};

async function transition(id: string, from: string, to: string, containerId?: string) {
  const [result] = await db.execute<ResultSetHeader>(
    `UPDATE instagram_publications SET status = ?, container_id = COALESCE(?, container_id),
       updated_at = UTC_TIMESTAMP() WHERE id = ? AND status = ? AND active = 1`,
    [to, containerId ?? null, id, from]
  );
  return result.affectedRows === 1;
}

async function updateUploadProgress(id: string, percent: number) {
  const [result] = await db.execute<ResultSetHeader>(
    `UPDATE instagram_publications SET upload_percent = ?, updated_at = UTC_TIMESTAMP()
     WHERE id = ? AND status = 'uploading' AND active = 1`,
    [percent, id]
  );
  if (result.affectedRows !== 1) throw new PublishError("The publication is no longer active.");
}

export async function publishInstagramStory(input: PublishInput) {
  let mayHavePublished = false;
  let stage = "starting";
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!await transition(input.id, "queued", "uploading")) return;
    stage = "uploading";
    file = await open(uploadFilePath(input.filepath), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await file.stat();
    if (!stats.isFile() || stats.size <= 0) throw new PublishError("Video file is missing or empty.");
    if (stats.size > 100_000_000) throw new PublishError("Instagram Story videos cannot exceed 100 MB.");
    await updateUploadProgress(input.id, 0);

    const graph = "https://graph.facebook.com/v27.0";
    const created = await metaJson(`${graph}/${encodeURIComponent(input.accountId)}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ media_type: "STORIES", upload_type: "resumable" }),
      signal: AbortSignal.timeout(30000),
    });
    if (typeof created.id !== "string" || !/^\d{1,191}$/.test(created.id)) {
      throw new PublishError("Meta did not return a valid container ID.");
    }
    const containerId = created.id;
    if (!await transition(input.id, "uploading", "uploading", containerId)) return;

    await uploadMetaVideo(file, stats.size,
      `https://rupload.facebook.com/ig-api-upload/v27.0/${containerId}`,
      input.token, (percent) => updateUploadProgress(input.id, percent));

    if (!await transition(input.id, "uploading", "processing")) return;
    stage = "processing";
    let ready = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 60000));
      const status = await metaJson(`${graph}/${containerId}?fields=status_code`, {
        headers: { Authorization: `Bearer ${input.token}` },
        signal: AbortSignal.timeout(30000),
      });
      if (status.status_code === "FINISHED") {
        ready = true;
        break;
      }
      if (status.status_code !== "IN_PROGRESS") {
        throw new PublishError("Meta could not process the video container.");
      }
    }
    if (!ready) throw new PublishError("Meta did not finish processing the video in time.");
    if (!await transition(input.id, "processing", "publishing")) return;
    mayHavePublished = true;
    stage = "publishing";
    const published = await metaJson(`${graph}/${encodeURIComponent(input.accountId)}/media_publish`, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ creation_id: containerId }),
      signal: AbortSignal.timeout(30000),
    });
    if (typeof published.id !== "string" || !/^\d{1,191}$/.test(published.id)) {
      throw new PublishError("Meta did not return a valid published media ID.");
    }
    await db.execute(
      `UPDATE instagram_publications SET status = 'published', active = NULL, media_id = ?,
       updated_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'publishing' AND active = 1`,
      [published.id, input.id]
    );
  } catch (error) {
    const detail = error instanceof PublishError ? error.message
      : error instanceof Error ? error.name : "Unknown error";
    console.error("Instagram publishing failed at", stage, detail);
    try {
      await db.execute(
        `UPDATE instagram_publications SET status = ?, active = ?, message = ?, updated_at = UTC_TIMESTAMP()
         WHERE id = ? AND active = 1`,
        [
          mayHavePublished ? "unknown" : "failed",
          mayHavePublished ? 1 : null,
          mayHavePublished
            ? "The publish result is unknown. Check Instagram before trying again."
            : error instanceof PublishError ? error.message : "The video could not be uploaded or processed. Check the server logs.",
          input.id,
        ]
      );
    } catch {
      console.error("Could not save Instagram publishing status. Check the database.");
    }
  } finally {
    if (file) await file.close();
  }
}
