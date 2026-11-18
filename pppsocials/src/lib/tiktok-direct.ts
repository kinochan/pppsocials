import { constants } from "fs";
import { open } from "fs/promises";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { db } from "@/src/lib/db";
import { tiktokConfig, tiktokPublishScope, tiktokUploadToken, TikTokConnectionError } from "@/src/lib/tiktok";
import { tiktokPublishRequest, TikTokUploadError } from "@/src/lib/tiktok-upload";
import { probeVideo, VideoProbeError } from "@/src/lib/video-probe";
import { uploadFilePath } from "@/src/lib/videos";

const privacyOptions = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"] as const;
export type TikTokPrivacy = typeof privacyOptions[number];
export class TikTokDirectError extends Error {}

export function isTikTokPrivacy(value: unknown): value is TikTokPrivacy {
  return privacyOptions.some((option) => option === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function creatorInfo(accountId: string) {
  const config = tiktokConfig();
  if (!config?.directEnabled) throw new TikTokDirectError("TikTok Direct Post is disabled.");
  const token = await tiktokUploadToken(accountId, config, tiktokPublishScope);
  const data = await tiktokPublishRequest("creator_info/query", token, {});
  if (typeof data.creator_nickname !== "string" || !data.creator_nickname || Array.from(data.creator_nickname).length > 255 ||
      !Array.isArray(data.privacy_level_options) || !data.privacy_level_options.length ||
      !data.privacy_level_options.every(isTikTokPrivacy) ||
      typeof data.comment_disabled !== "boolean" || typeof data.duet_disabled !== "boolean" ||
      typeof data.stitch_disabled !== "boolean" || typeof data.max_video_post_duration_sec !== "number" ||
      !Number.isSafeInteger(data.max_video_post_duration_sec) || data.max_video_post_duration_sec <= 0) {
    throw new TikTokDirectError("TikTok returned incomplete creator settings.");
  }
  return {
    nickname: data.creator_nickname,
    privacy: data.privacy_level_options,
    commentDisabled: data.comment_disabled,
    duetDisabled: data.duet_disabled,
    stitchDisabled: data.stitch_disabled,
    maxDuration: data.max_video_post_duration_sec,
  };
}

export async function inspectDirectVideo(storedPath: string, maxDuration: number) {
  const filepath = uploadFilePath(storedPath);
  const file = await open(filepath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await file.stat({ bigint: true });
    if (!stats.isFile() || stats.size <= BigInt(0) || stats.size > BigInt(4_000_000_000)) {
      throw new TikTokDirectError("The video is missing, empty, or exceeds TikTok's 4 GB limit.");
    }
    const metadata = await probeVideo(file, filepath);
    if (!isRecord(metadata) || !isRecord(metadata.format) || !Array.isArray(metadata.streams) ||
        metadata.streams.length !== 1) {
      throw new TikTokDirectError("Could not determine the video duration.");
    }
    const duration = Number(metadata.format.duration);
    if (!Number.isFinite(duration) || duration <= 0 || duration > maxDuration) {
      throw new TikTokDirectError(`The video must be no longer than ${maxDuration} seconds for this TikTok account.`);
    }
    return {
      device: stats.dev.toString(), inode: stats.ino.toString(), size: stats.size.toString(),
      mtimeNs: stats.mtimeNs.toString(),
    };
  } finally {
    await file.close();
  }
}

export type DirectPostInput = {
  id: string;
  accountId: string;
  secret: string;
  title: string;
  privacy: TikTokPrivacy;
  comment: boolean;
  duet: boolean;
  stitch: boolean;
  brandContent: boolean;
  brandOrganic: boolean;
  aiGenerated: boolean;
};

export async function startTikTokDirectPost(input: DirectPostInput) {
  let requestStarted = false;
  try {
    const [claimed] = await db.execute<ResultSetHeader>(
      `UPDATE tiktok_direct_posts SET status = 'starting', updated_at = UTC_TIMESTAMP()
       WHERE id = ? AND status = 'queued' AND active = 1`, [input.id]
    );
    if (claimed.affectedRows !== 1) return;
    const config = tiktokConfig();
    if (!config?.directEnabled) throw new TikTokDirectError("TikTok Direct Post is disabled.");
    const token = await tiktokUploadToken(input.accountId, config, tiktokPublishScope);
    const url = new URL(`/api/tiktok-media/${input.id}`, config.baseUrl);
    url.searchParams.set("token", input.secret);
    requestStarted = true;
    const result = await tiktokPublishRequest("video/init", token, {
      post_info: {
        title: input.title, privacy_level: input.privacy, disable_comment: !input.comment,
        disable_duet: !input.duet, disable_stitch: !input.stitch,
        brand_content_toggle: input.brandContent, brand_organic_toggle: input.brandOrganic,
        is_aigc: input.aiGenerated,
      },
      source_info: { source: "PULL_FROM_URL", video_url: url.toString() },
    });
    if (typeof result.publish_id !== "string" || !/^[A-Za-z0-9_~.-]{1,64}$/.test(result.publish_id)) {
      throw new TikTokDirectError("TikTok returned an invalid post ID.");
    }
    await db.execute(
      `UPDATE tiktok_direct_posts SET status = 'processing', publish_id = ?,
       token_expires_at = UTC_TIMESTAMP() + INTERVAL 60 MINUTE,
       message = 'TikTok accepted the request and is processing the video.', updated_at = UTC_TIMESTAMP()
       WHERE id = ? AND status = 'starting' AND active = 1`, [result.publish_id, input.id]
    );
  } catch (error) {
    const detail = error instanceof TikTokDirectError || error instanceof TikTokUploadError ||
      error instanceof TikTokConnectionError || error instanceof VideoProbeError ? error.message
      : "Check the server logs.";
    console.error("TikTok Direct Post failed:", error instanceof Error ? error.name : "Unknown error");
    try {
      await db.execute(
        `UPDATE tiktok_direct_posts SET status = ?, active = ?, message = ?, updated_at = UTC_TIMESTAMP()
         WHERE id = ? AND active = 1`,
        [requestStarted ? "unknown" : "failed", requestStarted ? 1 : null,
          requestStarted ? `Result uncertain. Check TikTok before retrying. ${detail}`.slice(0, 255) : detail, input.id]
      );
    } catch {
      console.error("Could not save TikTok Direct Post status. Check the database.");
    }
  }
}

interface DirectRow extends RowDataPacket {
  account_id: string;
  publish_id: string | null;
}

export async function checkTikTokDirectPost(id: string) {
  const [rows] = await db.execute<DirectRow[]>(
    "SELECT account_id, publish_id FROM tiktok_direct_posts WHERE id = ? AND active = 1 AND status IN ('processing', 'unknown')", [id]
  );
  if (!rows.length || !rows[0].publish_id) throw new TikTokDirectError("This post cannot be checked yet.");
  const config = tiktokConfig();
  if (!config?.directEnabled) throw new TikTokDirectError("TikTok Direct Post is disabled.");
  const token = await tiktokUploadToken(rows[0].account_id, config, tiktokPublishScope);
  const result = await tiktokPublishRequest("status/fetch", token, { publish_id: rows[0].publish_id });
  let status: string;
  let active: number | null;
  let message: string;
  if (result.status === "PROCESSING_DOWNLOAD" || result.status === "PROCESSING_UPLOAD") {
    status = "processing"; active = 1; message = "TikTok is processing the video.";
  } else if (result.status === "PUBLISH_COMPLETE") {
    status = "published"; active = null; message = "TikTok reports that the video was posted.";
  } else if (result.status === "FAILED") {
    const reason = typeof result.fail_reason === "string" && /^[a-z0-9_]{1,80}$/.test(result.fail_reason)
      ? result.fail_reason : "unknown";
    status = "failed"; active = null; message = `TikTok could not publish the video (${reason}).`;
  } else {
    throw new TikTokDirectError("TikTok returned an unrecognized post status.");
  }
  const [updated] = await db.execute<ResultSetHeader>(
    `UPDATE tiktok_direct_posts SET updated_at = IF(status = ?, updated_at, UTC_TIMESTAMP()),
     status = ?, active = ?, message = ?
     WHERE id = ? AND active = 1 AND status IN ('processing', 'unknown')`, [status, status, active, message, id]
  );
  if (!updated.affectedRows) throw new TikTokDirectError("The post status changed. Refresh and try again.");
}
