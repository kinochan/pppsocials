import { after } from "next/server";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { requireApiAccess } from "@/src/lib/access";
import { readAuthInput } from "@/src/lib/auth-input";
import { db } from "@/src/lib/db";
import { facebookConfig, savedFacebookPages } from "@/src/lib/facebook";
import { publishFacebookStory } from "@/src/lib/facebook-publish";
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

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  const videoId = new URL(request.url).searchParams.get("video");
  if (!videoId || !validVideoId(videoId)) return Response.json({ message: "Invalid video." }, { status: 400 });
  try {
    const config = facebookConfig();
    const pages = config ? await savedFacebookPages(config.key) : null;
    const [publications] = await db.execute<PublicationRow[]>(
      `SELECT id, page_id AS accountId, page_name AS username, status, message, post_id AS mediaId,
       'STORIES' AS mediaType,
       upload_percent AS uploadPercent, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS createdAt,
       (status = 'unknown' OR (active = 1 AND updated_at < UTC_TIMESTAMP() - INTERVAL 90 MINUTE)) AS canResolve
       FROM facebook_publications WHERE video_id = ? ORDER BY active DESC, created_at DESC, id DESC LIMIT 50`,
      [videoId]
    );
    return Response.json({
      enabled: !!config,
      accounts: (pages ?? []).map(({ id, name }) => ({ id, username: name })),
      publications,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("Could not load Facebook publishing information. Check configuration and database.");
    return Response.json({ message: "Unable to load Facebook publishing information." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  const input = await readAuthInput(request);
  if (!input || typeof input.id !== "string" || !uuid.test(input.id) ||
      typeof input.videoId !== "string" || !validVideoId(input.videoId) ||
      typeof input.filename !== "string" || !input.filename ||
      typeof input.accountId !== "string" || !/^\d{1,191}$/.test(input.accountId) ||
      input.mediaType !== "STORIES") {
    return Response.json({ message: "Invalid publishing request. Refresh the page and try again." }, { status: 400 });
  }
  try {
    const config = facebookConfig();
    if (!config) return Response.json({ message: "Facebook connection is disabled." }, { status: 503 });
    const pages = await savedFacebookPages(config.key);
    const page = pages?.find((item) => item.id === input.accountId);
    if (!page) return Response.json({ message: "Facebook Page is not connected." }, { status: 400 });
    const [videos] = await db.execute<VideoRow[]>("SELECT filename, filepath FROM videos WHERE id = ?", [input.videoId]);
    if (!videos.length || videos[0].filename !== input.filename) {
      return Response.json({ message: "The video changed. Refresh the library and try again." }, { status: 409 });
    }
    try {
      await db.execute(
        `INSERT INTO facebook_publications
         (id, video_id, page_id, page_name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
        [input.id, input.videoId, page.id, page.name]
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ER_DUP_ENTRY") {
        return Response.json({ message: "A request with this ID or an active publication already exists. Refresh the status before retrying." }, { status: 409 });
      }
      throw error;
    }
    const job = { id: input.id, pageId: page.id, filepath: videos[0].filepath, token: page.accessToken };
    after(() => publishFacebookStory(job));
    return Response.json({ id: input.id }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("Could not start Facebook publication. Check configuration and database.");
    return Response.json({ message: "Unable to start publishing. Refresh the status before retrying." }, { status: 503 });
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
      `UPDATE facebook_publications SET status = 'resolved', active = NULL,
       message = 'Manually resolved after checking Facebook.', updated_at = UTC_TIMESTAMP()
       WHERE id = ? AND active = 1 AND
         (status = 'unknown' OR updated_at < UTC_TIMESTAMP() - INTERVAL 90 MINUTE)`,
      [input.id]
    );
    if (!result.affectedRows) return Response.json({ message: "This publication cannot be resolved yet." }, { status: 409 });
    return Response.json({ success: true });
  } catch {
    console.error("Could not resolve Facebook publishing status. Check the database.");
    return Response.json({ message: "Unable to resolve publishing status." }, { status: 503 });
  }
}
