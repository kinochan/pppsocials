import type { RowDataPacket } from "mysql2";
import { db } from "@/src/lib/db";
import { decryptMetaSecret, encryptMetaSecret } from "@/src/lib/meta-crypto";

const graphUrl = "https://graph.facebook.com/v27.0";
export const facebookStateCookie = "__Host-facebook-oauth-state";

export type FacebookPage = { id: string; name: string; accessToken: string };
export class FacebookConnectionError extends Error {}

export function facebookConfig() {
  if (process.env.FACEBOOK_CONNECTION_ENABLED !== "true") return null;
  const { META_APP_ID, META_APP_SECRET, FACEBOOK_CONFIG_ID, APP_URL, INSTAGRAM_TOKEN_KEY } = process.env;
  if (!META_APP_ID || !META_APP_SECRET || !FACEBOOK_CONFIG_ID || !APP_URL ||
      !INSTAGRAM_TOKEN_KEY || !/^[0-9a-f]{64}$/i.test(INSTAGRAM_TOKEN_KEY)) {
    throw new Error("Facebook connection configuration is incomplete or invalid.");
  }
  const baseUrl = new URL(APP_URL);
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password ||
      baseUrl.pathname !== "/" || baseUrl.search || baseUrl.hash) {
    throw new Error("APP_URL must be an HTTPS origin without a path.");
  }
  return {
    appId: META_APP_ID,
    appSecret: META_APP_SECRET,
    configId: FACEBOOK_CONFIG_ID,
    baseUrl: baseUrl.origin,
    redirectUrl: `${baseUrl.origin}/api/facebook/callback`,
    key: Buffer.from(INSTAGRAM_TOKEN_KEY, "hex"),
  };
}

type FacebookConfig = NonNullable<ReturnType<typeof facebookConfig>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function graphRequest(url: URL, accessToken?: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new FacebookConnectionError("Meta API request could not be completed.");
  }
  if (!response.ok) throw new FacebookConnectionError(`Meta API request failed with HTTP ${response.status}.`);
  try {
    return await response.json();
  } catch {
    throw new FacebookConnectionError("Meta returned an invalid response.");
  }
}

export async function connectFacebook(code: string, config: FacebookConfig) {
  const tokenUrl = new URL(`${graphUrl}/oauth/access_token`);
  tokenUrl.searchParams.set("client_id", config.appId);
  tokenUrl.searchParams.set("client_secret", config.appSecret);
  tokenUrl.searchParams.set("redirect_uri", config.redirectUrl);
  tokenUrl.searchParams.set("code", code);
  const result = await graphRequest(tokenUrl);
  if (!isRecord(result) || typeof result.access_token !== "string" || !result.access_token) {
    throw new FacebookConnectionError("Meta did not return a user access token.");
  }

  const exchangeUrl = new URL(`${graphUrl}/oauth/access_token`);
  exchangeUrl.searchParams.set("grant_type", "fb_exchange_token");
  exchangeUrl.searchParams.set("client_id", config.appId);
  exchangeUrl.searchParams.set("client_secret", config.appSecret);
  exchangeUrl.searchParams.set("fb_exchange_token", result.access_token);
  const exchanged = await graphRequest(exchangeUrl);
  if (!isRecord(exchanged) || typeof exchanged.access_token !== "string" || !exchanged.access_token) {
    throw new FacebookConnectionError("Meta did not return a long-lived user access token.");
  }

  const pages: FacebookPage[] = [];
  const cursors = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < 100; page++) {
    const url = new URL(`${graphUrl}/me/accounts`);
    url.searchParams.set("fields", "id,name,access_token,tasks");
    url.searchParams.set("limit", "100");
    if (after) url.searchParams.set("after", after);
    const response = await graphRequest(url, exchanged.access_token);
    if (!isRecord(response) || !Array.isArray(response.data)) {
      throw new FacebookConnectionError("Meta returned an invalid Page list.");
    }
    for (const entry of response.data) {
      if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id ||
          typeof entry.name !== "string" || !entry.name ||
          typeof entry.access_token !== "string" || !entry.access_token || !Array.isArray(entry.tasks)) {
        throw new FacebookConnectionError("Meta returned invalid Page data.");
      }
      if (entry.tasks.includes("CREATE_CONTENT")) {
        pages.push({ id: entry.id, name: entry.name, accessToken: entry.access_token });
      }
    }
    if (!isRecord(response.paging) || !response.paging.next) {
      after = undefined;
      break;
    }
    if (!isRecord(response.paging.cursors) || typeof response.paging.cursors.after !== "string" ||
        !response.paging.cursors.after || cursors.has(response.paging.cursors.after)) {
      throw new FacebookConnectionError("Meta returned an invalid Page cursor.");
    }
    after = response.paging.cursors.after;
    cursors.add(after);
  }
  if (after) throw new FacebookConnectionError("Meta returned too many Page results.");
  if (!pages.length) throw new FacebookConnectionError("No Facebook Pages with publishing access were shared.");

  const encrypted = encryptMetaSecret(JSON.stringify(pages), config.key);
  try {
    await db.execute(
      `INSERT INTO facebook_connection (id, encrypted_pages) VALUES (1, ?)
       ON DUPLICATE KEY UPDATE encrypted_pages = VALUES(encrypted_pages)`,
      [encrypted]
    );
  } catch {
    throw new FacebookConnectionError("Could not save the Facebook connection in the database.");
  }
}

interface FacebookRow extends RowDataPacket {
  encrypted_pages: string;
}

export async function savedFacebookPages(key: Buffer): Promise<FacebookPage[] | null> {
  const [rows] = await db.execute<FacebookRow[]>("SELECT encrypted_pages FROM facebook_connection WHERE id = 1");
  if (!rows.length) return null;
  const payload: unknown = JSON.parse(decryptMetaSecret(rows[0].encrypted_pages, key));
  if (!Array.isArray(payload) || !payload.every((page) =>
    isRecord(page) && typeof page.id === "string" && typeof page.name === "string" &&
    typeof page.accessToken === "string")) {
    throw new Error("Invalid stored Facebook Page data.");
  }
  return payload;
}
