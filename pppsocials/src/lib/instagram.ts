import type { RowDataPacket } from "mysql2";
import { db } from "@/src/lib/db";
import { decryptMetaSecret, encryptMetaSecret } from "@/src/lib/meta-crypto";

const graphUrl = "https://graph.facebook.com/v27.0";
export const stateCookie = "__Host-instagram-oauth-state";

export type InstagramAccount = { id: string; username: string };
export class InstagramConnectionError extends Error {}

export function instagramConfig() {
  if (process.env.INSTAGRAM_CONNECTION_ENABLED !== "true") {
    return null;
  }

  const { META_APP_ID, META_APP_SECRET, META_CONFIG_ID, APP_URL, INSTAGRAM_TOKEN_KEY } = process.env;
  if (!META_APP_ID || !META_APP_SECRET || !META_CONFIG_ID || !APP_URL ||
      !INSTAGRAM_TOKEN_KEY || !/^[0-9a-f]{64}$/i.test(INSTAGRAM_TOKEN_KEY)) {
    throw new Error("Instagram connection configuration is incomplete or invalid.");
  }

  const baseUrl = new URL(APP_URL);
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password ||
      baseUrl.pathname !== "/" || baseUrl.search || baseUrl.hash) {
    throw new Error("APP_URL must be an HTTPS origin without a path.");
  }

  return {
    appId: META_APP_ID,
    appSecret: META_APP_SECRET,
    configId: META_CONFIG_ID,
    baseUrl: baseUrl.origin,
    redirectUrl: `${baseUrl.origin}/api/instagram/callback`,
    key: Buffer.from(INSTAGRAM_TOKEN_KEY, "hex"),
  };
}

type InstagramConfig = NonNullable<ReturnType<typeof instagramConfig>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function graphRequest(url: URL, operation: string, accessToken?: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new InstagramConnectionError("Meta API request could not be completed.");
  }
  if (!response.ok) {
    throw new InstagramConnectionError(`Meta ${operation} request failed with HTTP ${response.status}.`);
  }
  try {
    return await response.json();
  } catch {
    throw new InstagramConnectionError("Meta returned an invalid response.");
  }
}

export async function connectInstagram(code: string, config: InstagramConfig) {
  const tokenUrl = new URL(`${graphUrl}/oauth/access_token`);
  tokenUrl.searchParams.set("client_id", config.appId);
  tokenUrl.searchParams.set("client_secret", config.appSecret);
  tokenUrl.searchParams.set("redirect_uri", config.redirectUrl);
  tokenUrl.searchParams.set("code", code);
  const tokenResult = await graphRequest(tokenUrl, "authorization code exchange");
  if (!isRecord(tokenResult) || typeof tokenResult.access_token !== "string" || !tokenResult.access_token) {
    throw new InstagramConnectionError("Meta did not return an access token.");
  }
  const token = tokenResult.access_token;

  const businessUrl = new URL(`${graphUrl}/me`);
  businessUrl.searchParams.set("fields", "client_business_id");
  const business = await graphRequest(businessUrl, "business lookup", token);
  if (!isRecord(business) || typeof business.client_business_id !== "string" || !business.client_business_id) {
    throw new InstagramConnectionError("Meta did not return a business ID.");
  }

  const accounts: InstagramAccount[] = [];
  const seenCursors = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < 100; page++) {
    const accountsUrl = new URL(`${graphUrl}/me/assigned_instagram_accounts`);
    accountsUrl.searchParams.set("fields", "id,username");
    accountsUrl.searchParams.set("limit", "100");
    if (after) accountsUrl.searchParams.set("after", after);
    const result = await graphRequest(accountsUrl, "Instagram account lookup", token);
    if (!isRecord(result) || !Array.isArray(result.data)) {
      throw new InstagramConnectionError("Meta returned an invalid account list.");
    }
    for (const account of result.data) {
      if (!isRecord(account) || typeof account.id !== "string" || !account.id ||
          typeof account.username !== "string" || !account.username) {
        throw new InstagramConnectionError("Meta returned an invalid Instagram account.");
      }
      accounts.push({ id: account.id, username: account.username });
    }
    if (!isRecord(result.paging) || !result.paging.next) {
      after = undefined;
      break;
    }
    const cursors = result.paging.cursors;
    if (!isRecord(cursors) || typeof cursors.after !== "string" || !cursors.after ||
        seenCursors.has(cursors.after)) {
      throw new InstagramConnectionError("Meta returned an invalid account page cursor.");
    }
    after = cursors.after;
    seenCursors.add(after);
  }
  if (after) throw new InstagramConnectionError("Meta returned too many account pages.");
  if (accounts.length === 0) throw new InstagramConnectionError("No Instagram accounts were shared.");

  const encryptedToken = encryptMetaSecret(token, config.key);

  try {
    const uniqueAccounts = [...new Map(accounts.map((account) => [account.id, account])).values()];
    const placeholders = uniqueAccounts.map(() => "(?, ?, ?)").join(", ");
    const values = uniqueAccounts.flatMap((account) => [account.id, account.username, encryptedToken]);
    await db.execute(
      `INSERT INTO instagram_accounts (account_id, username, encrypted_token)
       VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE username = VALUES(username), encrypted_token = VALUES(encrypted_token)`,
      values
    );
  } catch {
    throw new InstagramConnectionError("Could not save the Instagram connection in the database.");
  }
}

interface ConnectionRow extends RowDataPacket {
  accounts: string;
}

interface InstagramAccountRow extends RowDataPacket {
  id: string;
  username: string;
}

function mergeAccounts(...groups: InstagramAccount[][]): InstagramAccount[] {
  return [...new Map(groups.flat().map((account) => [account.id, account])).values()];
}

function parseAccounts(value: string): InstagramAccount[] {
  const accounts: unknown = JSON.parse(value);
  if (!Array.isArray(accounts) || !accounts.every(
    (account) => isRecord(account) && typeof account.id === "string" && typeof account.username === "string"
  )) {
    throw new Error("Stored Instagram account data is invalid.");
  }
  return accounts;
}

export async function savedInstagramAccounts(): Promise<InstagramAccount[] | null> {
  const [[accounts], [connections]] = await Promise.all([
    db.execute<InstagramAccountRow[]>(
      "SELECT account_id AS id, username FROM instagram_accounts ORDER BY username, account_id"
    ),
    db.execute<ConnectionRow[]>(
      "SELECT accounts FROM instagram_connection WHERE id = 1"
    ),
  ]);
  const legacyAccounts = connections.length ? parseAccounts(connections[0].accounts) : [];
  const saved = mergeAccounts(legacyAccounts, accounts);
  return saved.length ? saved : null;
}

interface PublishingConnectionRow extends ConnectionRow {
  encrypted_token: string;
}

interface InstagramPublishingAccountRow extends InstagramAccountRow {
  encrypted_token: string;
}

export async function instagramPublishingConnection(accountId: string, key: Buffer) {
  const [accounts] = await db.execute<InstagramPublishingAccountRow[]>(
    "SELECT account_id AS id, username, encrypted_token FROM instagram_accounts WHERE account_id = ?",
    [accountId]
  );
  if (accounts.length) {
    return {
      account: { id: accounts[0].id, username: accounts[0].username },
      token: decryptMetaSecret(accounts[0].encrypted_token, key),
    };
  }

  const [connections] = await db.execute<PublishingConnectionRow[]>(
    "SELECT accounts, encrypted_token FROM instagram_connection WHERE id = 1"
  );
  if (!connections.length) return null;
  const account = parseAccounts(connections[0].accounts).find((item) => item.id === accountId);
  if (!account) return null;
  return {
    account,
    token: decryptMetaSecret(connections[0].encrypted_token, key),
  };
}
