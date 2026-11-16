import type { RowDataPacket } from "mysql2";
import { db } from "@/src/lib/db";
import { encryptMetaSecret } from "@/src/lib/meta-crypto";

export const youtubeStateCookie = "__Host-youtube-oauth";
export const youtubeReadonlyScope = "https://www.googleapis.com/auth/youtube.readonly";
export class YouTubeConnectionError extends Error {}

export function youtubeConfig() {
  if (process.env.YOUTUBE_CONNECTION_ENABLED !== "true") return null;
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, APP_URL, INSTAGRAM_TOKEN_KEY } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !APP_URL ||
      !INSTAGRAM_TOKEN_KEY || !/^[0-9a-f]{64}$/i.test(INSTAGRAM_TOKEN_KEY)) {
    throw new Error("YouTube connection configuration is incomplete or invalid.");
  }
  const baseUrl = new URL(APP_URL);
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password ||
      baseUrl.pathname !== "/" || baseUrl.search || baseUrl.hash) {
    throw new Error("APP_URL must be an HTTPS origin without a path.");
  }
  return {
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    baseUrl: baseUrl.origin,
    redirectUrl: `${baseUrl.origin}/api/youtube/callback`,
    key: Buffer.from(INSTAGRAM_TOKEN_KEY, "hex"),
  };
}

type YouTubeConfig = NonNullable<ReturnType<typeof youtubeConfig>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function googleRequest(url: string, operation: string, options: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new YouTubeConnectionError(`Google ${operation} request could not be completed.`);
  }
  if (!response.ok) throw new YouTubeConnectionError(`Google ${operation} request failed with HTTP ${response.status}.`);
  try {
    return await response.json();
  } catch {
    throw new YouTubeConnectionError(`Google ${operation} returned an invalid response.`);
  }
}

export async function connectYouTube(code: string, verifier: string, config: YouTubeConfig) {
  const tokenResult = await googleRequest("https://oauth2.googleapis.com/token", "token exchange", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      code_verifier: verifier,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUrl,
      grant_type: "authorization_code",
    }),
  });
  if (!isRecord(tokenResult) || typeof tokenResult.access_token !== "string" || !tokenResult.access_token ||
      typeof tokenResult.refresh_token !== "string" || !tokenResult.refresh_token) {
    throw new YouTubeConnectionError("Google did not return an access token and offline refresh token.");
  }
  if (typeof tokenResult.scope !== "string" || !tokenResult.scope.split(" ").includes(youtubeReadonlyScope)) {
    throw new YouTubeConnectionError("Google did not grant the required YouTube read-only permission.");
  }

  const channelUrl = new URL("https://www.googleapis.com/youtube/v3/channels");
  channelUrl.searchParams.set("part", "snippet");
  channelUrl.searchParams.set("mine", "true");
  channelUrl.searchParams.set("maxResults", "50");
  const result = await googleRequest(channelUrl.toString(), "channel lookup", {
    headers: { Authorization: `Bearer ${tokenResult.access_token}` },
  });
  if (!isRecord(result) || !Array.isArray(result.items) || result.items.length !== 1 ||
      result.nextPageToken || !isRecord(result.items[0])) {
    throw new YouTubeConnectionError("Google did not return exactly one authorized YouTube channel.");
  }
  const channel = result.items[0];
  if (typeof channel.id !== "string" || !channel.id || channel.id.length > 128 ||
      !/^[A-Za-z0-9_-]+$/.test(channel.id) || !isRecord(channel.snippet) ||
      typeof channel.snippet.title !== "string" || !channel.snippet.title ||
      Array.from(channel.snippet.title).length > 255) {
    throw new YouTubeConnectionError("Google returned invalid YouTube channel details.");
  }

  const encrypted = encryptMetaSecret(tokenResult.refresh_token, config.key);
  try {
    await db.execute(
      `INSERT INTO youtube_channels (channel_id, title, encrypted_refresh_token) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE title = VALUES(title), encrypted_refresh_token = VALUES(encrypted_refresh_token)`,
      [channel.id, channel.snippet.title, encrypted]
    );
  } catch {
    throw new YouTubeConnectionError("Could not save the YouTube connection in the database.");
  }
}

interface YouTubeChannelRow extends RowDataPacket {
  id: string;
  title: string;
}

export async function savedYouTubeChannels(): Promise<YouTubeChannelRow[]> {
  const [rows] = await db.execute<YouTubeChannelRow[]>(
    "SELECT channel_id AS id, title FROM youtube_channels ORDER BY title, channel_id"
  );
  return rows;
}
