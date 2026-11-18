import type { RowDataPacket } from "mysql2";
import { db } from "@/src/lib/db";
import { decryptMetaSecret, encryptMetaSecret } from "@/src/lib/meta-crypto";

export const youtubeStateCookie = "__Host-youtube-oauth";
export const youtubeReadonlyScope = "https://www.googleapis.com/auth/youtube.readonly";
export const youtubeUploadScope = "https://www.googleapis.com/auth/youtube.upload";
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
  const scopes = typeof tokenResult.scope === "string" ? tokenResult.scope.split(" ") : [];
  if (![youtubeReadonlyScope, youtubeUploadScope].every((scope) => scopes.includes(scope))) {
    throw new YouTubeConnectionError("Google did not grant both required YouTube permissions.");
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

interface YouTubeTokenRow extends RowDataPacket {
  encrypted_refresh_token: string;
}

export async function youtubePublishingToken(channelId: string, config: YouTubeConfig) {
  const [rows] = await db.execute<YouTubeTokenRow[]>(
    "SELECT encrypted_refresh_token FROM youtube_channels WHERE channel_id = ?", [channelId]
  );
  if (!rows.length) throw new YouTubeConnectionError("YouTube channel is not connected.");
  const refreshToken = decryptMetaSecret(rows[0].encrypted_refresh_token, config.key);
  const result = await googleRequest("https://oauth2.googleapis.com/token", "token refresh", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!isRecord(result) || typeof result.access_token !== "string" || !result.access_token) {
    throw new YouTubeConnectionError("Google did not return an access token. Reconnect the channel.");
  }
  if (typeof result.scope === "string" && !result.scope.split(" ").includes(youtubeUploadScope)) {
    throw new YouTubeConnectionError("Reconnect the channel and grant YouTube upload permission.");
  }
  const url = "https://www.googleapis.com/youtube/v3/channels?part=id&mine=true";
  const channel = await googleRequest(url, "channel lookup", {
    headers: { Authorization: `Bearer ${result.access_token}` },
  });
  if (!isRecord(channel) || !Array.isArray(channel.items) || channel.items.length !== 1 ||
      channel.nextPageToken || !isRecord(channel.items[0]) || channel.items[0].id !== channelId) {
    throw new YouTubeConnectionError("The authorized YouTube channel changed. Reconnect the intended channel.");
  }
  return result.access_token;
}
