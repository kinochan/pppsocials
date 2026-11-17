import type { RowDataPacket } from "mysql2";
import { db } from "@/src/lib/db";
import { encryptMetaSecret } from "@/src/lib/meta-crypto";

export const tiktokStateCookie = "__Host-tiktok-oauth-state";
export const tiktokBasicScope = "user.info.basic";
export class TikTokConnectionError extends Error {}

export function tiktokConfig() {
  if (process.env.TIKTOK_CONNECTION_ENABLED !== "true") return null;
  const { TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, APP_URL, INSTAGRAM_TOKEN_KEY } = process.env;
  if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET || !APP_URL ||
      !INSTAGRAM_TOKEN_KEY || !/^[0-9a-f]{64}$/i.test(INSTAGRAM_TOKEN_KEY)) {
    throw new Error("TikTok connection configuration is incomplete or invalid.");
  }
  const baseUrl = new URL(APP_URL);
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password ||
      baseUrl.pathname !== "/" || baseUrl.search || baseUrl.hash) {
    throw new Error("APP_URL must be an HTTPS origin without a path.");
  }
  return {
    clientKey: TIKTOK_CLIENT_KEY,
    clientSecret: TIKTOK_CLIENT_SECRET,
    baseUrl: baseUrl.origin,
    redirectUrl: `${baseUrl.origin}/api/tiktok/callback`,
    key: Buffer.from(INSTAGRAM_TOKEN_KEY, "hex"),
  };
}

type TikTokConfig = NonNullable<ReturnType<typeof tiktokConfig>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function tiktokRequest(url: string, operation: string, options: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new TikTokConnectionError(`TikTok ${operation} request could not be completed.`);
  }
  if (!response.ok) throw new TikTokConnectionError(`TikTok ${operation} request failed with HTTP ${response.status}.`);
  try {
    return await response.json();
  } catch {
    throw new TikTokConnectionError(`TikTok ${operation} returned an invalid response.`);
  }
}

export async function connectTikTok(code: string, config: TikTokConfig) {
  const tokenResult = await tiktokRequest("https://open.tiktokapis.com/v2/oauth/token/", "token exchange", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: config.clientKey,
      client_secret: config.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: config.redirectUrl,
    }),
  });
  if (!isRecord(tokenResult) || typeof tokenResult.access_token !== "string" || !tokenResult.access_token ||
      typeof tokenResult.refresh_token !== "string" || !tokenResult.refresh_token ||
      typeof tokenResult.open_id !== "string" || !tokenResult.open_id ||
      Array.from(tokenResult.open_id).length > 191 ||
      typeof tokenResult.scope !== "string" || !tokenResult.scope.split(",").map((scope) => scope.trim()).includes(tiktokBasicScope) ||
      typeof tokenResult.expires_in !== "number" || !Number.isSafeInteger(tokenResult.expires_in) || tokenResult.expires_in <= 0 ||
      typeof tokenResult.refresh_expires_in !== "number" || !Number.isSafeInteger(tokenResult.refresh_expires_in) ||
      tokenResult.refresh_expires_in <= 0) {
    throw new TikTokConnectionError("TikTok did not return valid tokens, expiry times, and basic account permission.");
  }
  const now = Date.now();
  const accessExpiresAt = now + tokenResult.expires_in * 1000;
  const refreshExpiresAt = now + tokenResult.refresh_expires_in * 1000;
  if (!Number.isSafeInteger(accessExpiresAt) || !Number.isSafeInteger(refreshExpiresAt)) {
    throw new TikTokConnectionError("TikTok returned invalid token expiry times.");
  }

  const userUrl = new URL("https://open.tiktokapis.com/v2/user/info/");
  userUrl.searchParams.set("fields", "open_id,display_name");
  const result = await tiktokRequest(userUrl.toString(), "account lookup", {
    headers: { Authorization: `Bearer ${tokenResult.access_token}` },
  });
  if (!isRecord(result) || !isRecord(result.error) || result.error.code !== "ok" ||
      !isRecord(result.data) || !isRecord(result.data.user)) {
    throw new TikTokConnectionError("TikTok did not return valid account details.");
  }
  const user = result.data.user;
  if (user.open_id !== tokenResult.open_id || typeof user.display_name !== "string" ||
      !user.display_name || Array.from(user.display_name).length > 255) {
    throw new TikTokConnectionError("TikTok returned invalid or mismatched account details.");
  }

  const encrypted = encryptMetaSecret(JSON.stringify({
    accessToken: tokenResult.access_token,
    refreshToken: tokenResult.refresh_token,
    scope: tokenResult.scope,
    accessExpiresAt,
    refreshExpiresAt,
  }), config.key);
  try {
    await db.execute(
      `INSERT INTO tiktok_accounts (open_id, display_name, encrypted_tokens) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), encrypted_tokens = VALUES(encrypted_tokens)`,
      [tokenResult.open_id, user.display_name, encrypted]
    );
  } catch {
    throw new TikTokConnectionError("Could not save the TikTok connection in the database.");
  }
}

interface TikTokAccountRow extends RowDataPacket {
  id: string;
  displayName: string;
}

export async function savedTikTokAccounts(): Promise<TikTokAccountRow[]> {
  const [rows] = await db.execute<TikTokAccountRow[]>(
    "SELECT open_id AS id, display_name AS displayName FROM tiktok_accounts ORDER BY display_name, open_id"
  );
  return rows;
}
