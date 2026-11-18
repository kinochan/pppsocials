import { after } from "next/server";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { requireApiAccess } from "@/src/lib/access";
import { readAuthInput } from "@/src/lib/auth-input";
import { db } from "@/src/lib/db";
import { savedYouTubeChannels, youtubeConfig } from "@/src/lib/youtube";
import { publishYouTubeVideo, type YouTubePublishInput } from "@/src/lib/youtube-publish";
import { validVideoId } from "@/src/lib/videos";

export const maxDuration = 3600;

interface VideoRow extends RowDataPacket {
  filename: string;
  filepath: string;
}

interface PublicationRow extends RowDataPacket {
  id: string;
  channelTitle: string;
  status: string;
  requestedPrivacy: string;
  actualPrivacy: string | null;
  uploadPercent: number | null;
  message: string | null;
  youtubeVideoId: string | null;
  createdAt: string;
  canResolve: number;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  const videoId = new URL(request.url).searchParams.get("video");
  if (!videoId || !validVideoId(videoId)) return Response.json({ message: "Invalid video." }, { status: 400 });
  try {
    const config = youtubeConfig();
    const channels = config ? await savedYouTubeChannels() : [];
    const [publications] = await db.execute<PublicationRow[]>(
      `SELECT id, channel_title AS channelTitle, status, requested_privacy AS requestedPrivacy,
       actual_privacy AS actualPrivacy, upload_percent AS uploadPercent, message,
       youtube_video_id AS youtubeVideoId, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS createdAt,
       (status = 'unknown' OR (active = 1 AND updated_at < UTC_TIMESTAMP() - INTERVAL 90 MINUTE)) AS canResolve
       FROM youtube_publications WHERE video_id = ? ORDER BY active DESC, created_at DESC, id DESC LIMIT 50`,
      [videoId]
    );
    return Response.json({ enabled: !!config, channels, publications }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    console.error("Could not load YouTube publishing information. Check configuration and database.");
    return Response.json({ message: "Unable to load YouTube publishing information." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  const input = await readAuthInput(request, 65536);
  if (!input || typeof input.id !== "string" || !uuid.test(input.id) ||
      typeof input.videoId !== "string" || !validVideoId(input.videoId) ||
      typeof input.filename !== "string" || !input.filename ||
      typeof input.channelId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.channelId) ||
      typeof input.title !== "string" || !input.title.trim() || Array.from(input.title).length > 100 ||
      /[<>]/.test(input.title) ||
      typeof input.description !== "string" || Buffer.byteLength(input.description, "utf8") > 5000 ||
      /[<>]/.test(input.description) ||
      (input.privacy !== "public" && input.privacy !== "private" && input.privacy !== "unlisted") ||
      typeof input.madeForKids !== "boolean" || typeof input.syntheticMedia !== "boolean" ||
      input.certify !== true) {
    return Response.json({ message: "Check the YouTube title, description, audience, privacy, and certification." }, { status: 400 });
  }
  try {
    if (!youtubeConfig()) return Response.json({ message: "YouTube connection is disabled." }, { status: 503 });
    const channels = await savedYouTubeChannels();
    const channel = channels.find((item) => item.id === input.channelId);
    if (!channel) return Response.json({ message: "YouTube channel is not connected." }, { status: 400 });
    const [videos] = await db.execute<VideoRow[]>("SELECT filename, filepath FROM videos WHERE id = ?", [input.videoId]);
    if (!videos.length || videos[0].filename !== input.filename) {
      return Response.json({ message: "The video changed. Refresh the library and try again." }, { status: 409 });
    }
    try {
      await db.execute(
        `INSERT INTO youtube_publications
         (id, video_id, channel_id, channel_title, status, requested_privacy, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
        [input.id, input.videoId, channel.id, channel.title, input.privacy]
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ER_DUP_ENTRY") {
        return Response.json({ message: "A request with this ID or an active upload already exists. Refresh the status before retrying." }, { status: 409 });
      }
      throw error;
    }
    const job: YouTubePublishInput = {
      id: input.id, channelId: channel.id, filepath: videos[0].filepath,
      title: input.title, description: input.description, privacy: input.privacy,
      madeForKids: input.madeForKids, syntheticMedia: input.syntheticMedia,
    };
    after(() => publishYouTubeVideo(job));
    return Response.json({ id: input.id }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("Could not start YouTube upload. Check configuration and database.");
    return Response.json({ message: "Unable to start uploading. Refresh the status before retrying." }, { status: 503 });
  }
}

export async function PATCH(request: Request) {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  const input = await readAuthInput(request);
  if (!input || typeof input.id !== "string" || !uuid.test(input.id) || input.confirm !== true) {
    return Response.json({ message: "Invalid status resolution request." }, { status: 400 });
  }
  try {
    const [result] = await db.execute<ResultSetHeader>(
      `UPDATE youtube_publications SET status = 'resolved', active = NULL,
       message = 'Manually resolved after checking YouTube Studio.', updated_at = UTC_TIMESTAMP()
       WHERE id = ? AND active = 1 AND
         (status = 'unknown' OR updated_at < UTC_TIMESTAMP() - INTERVAL 90 MINUTE)`,
      [input.id]
    );
    if (!result.affectedRows) return Response.json({ message: "This upload cannot be resolved yet." }, { status: 409 });
    return Response.json({ success: true });
  } catch {
    console.error("Could not resolve YouTube upload status. Check the database.");
    return Response.json({ message: "Unable to resolve upload status." }, { status: 503 });
  }
}
