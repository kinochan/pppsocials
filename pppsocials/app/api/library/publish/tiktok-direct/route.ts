import { createHash, randomBytes } from "crypto";
import path from "path";
import { after } from "next/server";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { requireApiAccess } from "@/src/lib/access";
import { readAuthInput } from "@/src/lib/auth-input";
import { db } from "@/src/lib/db";
import { savedTikTokAccounts, tiktokConfig, TikTokConnectionError } from "@/src/lib/tiktok";
import { checkTikTokDirectPost, creatorInfo, inspectDirectVideo, isTikTokPrivacy, startTikTokDirectPost, TikTokDirectError } from "@/src/lib/tiktok-direct";
import { TikTokUploadError } from "@/src/lib/tiktok-upload";
import { VideoProbeError } from "@/src/lib/video-probe";
import { validVideoId } from "@/src/lib/videos";

interface VideoRow extends RowDataPacket { filename: string; filepath: string }
interface PostRow extends RowDataPacket {
  id: string; accountName: string; status: string; message: string | null;
  createdAt: string; canCheck: number; canResolve: number;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function errorResponse(error: unknown) {
  console.error("TikTok Direct Post request failed:", error instanceof Error ? error.name : "Unknown error");
  const message = error instanceof TikTokDirectError || error instanceof TikTokConnectionError ||
    error instanceof TikTokUploadError || error instanceof VideoProbeError
    ? error.message : "Unable to process the TikTok request. Check the server logs.";
  return Response.json({ message }, { status: 503 });
}

export async function GET(request: Request) {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const videoId = params.get("video");
  const accountId = params.get("creator");
  if (!videoId || !validVideoId(videoId)) return Response.json({ message: "Invalid video." }, { status: 400 });
  try {
    const config = tiktokConfig();
    if (accountId) {
      if (!config?.directEnabled) return Response.json({ message: "TikTok Direct Post is disabled." }, { status: 503 });
      if (!(await savedTikTokAccounts()).some((item) => item.id === accountId)) {
        return Response.json({ message: "TikTok account is not connected." }, { status: 400 });
      }
      return Response.json(await creatorInfo(accountId), { headers: { "Cache-Control": "no-store" } });
    }
    if (!config?.directEnabled) return Response.json({ enabled: false, accounts: [], posts: [] }, {
      headers: { "Cache-Control": "no-store" },
    });
    const accounts = await savedTikTokAccounts();
    const [posts] = await db.execute<PostRow[]>(
      `SELECT id, account_name AS accountName, status, message,
       DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS createdAt,
       (active = 1 AND status IN ('processing', 'unknown') AND publish_id IS NOT NULL) AS canCheck,
       (active = 1 AND (status = 'unknown' OR updated_at < UTC_TIMESTAMP() - INTERVAL 90 MINUTE)) AS canResolve
       FROM tiktok_direct_posts WHERE video_id = ? ORDER BY active DESC, created_at DESC, id DESC LIMIT 50`, [videoId]
    );
    return Response.json({ enabled: true, accounts, posts }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  const input = await readAuthInput(request, 65536);
  if (!input || typeof input.id !== "string" || !uuid.test(input.id) ||
      typeof input.videoId !== "string" || !validVideoId(input.videoId) ||
      typeof input.filename !== "string" || !input.filename ||
      typeof input.accountId !== "string" || !input.accountId ||
      typeof input.title !== "string" || input.title.length > 2200 ||
      !isTikTokPrivacy(input.privacy) ||
      typeof input.comment !== "boolean" || typeof input.duet !== "boolean" || typeof input.stitch !== "boolean" ||
      typeof input.brandContent !== "boolean" || typeof input.brandOrganic !== "boolean" ||
      typeof input.disclosure !== "boolean" || typeof input.aiGenerated !== "boolean" || input.confirm !== true ||
      (input.disclosure !== (input.brandContent || input.brandOrganic)) ||
      (input.brandContent && input.privacy === "SELF_ONLY")) {
    return Response.json({ message: "Check the TikTok post settings and consent." }, { status: 400 });
  }
  try {
    const config = tiktokConfig();
    if (!config?.directEnabled) return Response.json({ message: "TikTok Direct Post is disabled." }, { status: 503 });
    const account = (await savedTikTokAccounts()).find((item) => item.id === input.accountId);
    if (!account) return Response.json({ message: "TikTok account is not connected." }, { status: 400 });
    const creator = await creatorInfo(account.id);
    if (!creator.privacy.includes(input.privacy) ||
        (input.comment && creator.commentDisabled) || (input.duet && creator.duetDisabled) ||
        (input.stitch && creator.stitchDisabled)) {
      return Response.json({ message: "TikTok account settings changed. Refresh and choose again." }, { status: 409 });
    }
    const [videos] = await db.execute<VideoRow[]>("SELECT filename, filepath FROM videos WHERE id = ?", [input.videoId]);
    if (!videos.length || videos[0].filename !== input.filename) {
      return Response.json({ message: "The video changed. Refresh the library and try again." }, { status: 409 });
    }
    if (![".mp4", ".mov", ".webm"].includes(path.extname(videos[0].filepath).toLowerCase())) {
      return Response.json({ message: "TikTok accepts MP4, MOV, or WebM videos." }, { status: 400 });
    }
    const file = await inspectDirectVideo(videos[0].filepath, creator.maxDuration);
    const secret = randomBytes(32).toString("hex");
    const hash = createHash("sha256").update(secret, "ascii").digest("hex");
    try {
      await db.execute(
        `INSERT INTO tiktok_direct_posts
         (id, video_id, account_id, account_name, filepath, filename, file_device, file_inode, file_size, file_mtime_ns,
          token_hash, token_expires_at, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP() + INTERVAL 60 MINUTE, 'queued', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
        [input.id, input.videoId, account.id, creator.nickname, videos[0].filepath, videos[0].filename,
          file.device, file.inode, file.size, file.mtimeNs, hash]
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ER_DUP_ENTRY") {
        return Response.json({ message: "An active TikTok post or request with this ID already exists." }, { status: 409 });
      }
      throw error;
    }
    const job = {
      id: input.id, accountId: account.id, secret, title: input.title, privacy: input.privacy,
      comment: input.comment, duet: input.duet, stitch: input.stitch,
      brandContent: input.brandContent, brandOrganic: input.brandOrganic, aiGenerated: input.aiGenerated,
    };
    after(() => startTikTokDirectPost(job));
    return Response.json({ id: input.id }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
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
      await checkTikTokDirectPost(input.id);
    } else {
      const [result] = await db.execute<ResultSetHeader>(
        `UPDATE tiktok_direct_posts SET status = 'resolved', active = NULL,
         message = 'Manually resolved after checking TikTok.', updated_at = UTC_TIMESTAMP()
         WHERE id = ? AND active = 1 AND (status = 'unknown' OR updated_at < UTC_TIMESTAMP() - INTERVAL 90 MINUTE)`, [input.id]
      );
      if (!result.affectedRows) return Response.json({ message: "This post cannot be resolved yet." }, { status: 409 });
    }
    return Response.json({ success: true });
  } catch (error) {
    return errorResponse(error);
  }
}
