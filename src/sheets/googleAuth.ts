/**
 * Google service-account auth for the Sheets API, done by hand with
 * WebCrypto — Workers can't run Google's Node client, and the flow is
 * small: sign a JWT with the account's private key, trade it for an
 * access token, reuse the token until shortly before it expires.
 *
 * The secret GOOGLE_SERVICE_ACCOUNT_JSON is the key file Google Cloud
 * hands you when you create a key for the service account (README
 * "Google Sheet"). The sheet itself must be shared with the account's
 * client_email as an Editor; that sharing is the whole permission model.
 */

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

export function parseServiceAccountKey(raw: string | undefined): ServiceAccountKey {
  if (!raw) throw new Error("missing required secret GOOGLE_SERVICE_ACCOUNT_JSON — see README 'Google Sheet'");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON isn't valid JSON — paste the whole key file Google Cloud downloaded");
  }
  const key = parsed as Partial<ServiceAccountKey>;
  if (typeof key.client_email !== "string" || typeof key.private_key !== "string") {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key — it should be a service-account key file");
  }
  return { client_email: key.client_email, private_key: key.private_key, token_uri: key.token_uri };
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlFromString(text: string): string {
  return base64UrlFromBytes(new TextEncoder().encode(text));
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\\n/g, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** The signed assertion Google's token endpoint accepts. Exported for the
 * test that checks it verifies against the matching public key. */
export async function signServiceAccountJwt(key: ServiceAccountKey, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: key.client_email,
    scope: SCOPE,
    aud: key.token_uri ?? DEFAULT_TOKEN_URI,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const unsigned = `${base64UrlFromString(JSON.stringify(header))}.${base64UrlFromString(JSON.stringify(claims))}`;
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(key.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64UrlFromBytes(new Uint8Array(signature))}`;
}

// One token per isolate, refreshed a few minutes before Google expires it.
let cached: { email: string; token: string; expiresAt: number } | null = null;

export async function getGoogleAccessToken(rawKey: string | undefined): Promise<string> {
  const key = parseServiceAccountKey(rawKey);
  if (cached && cached.email === key.client_email && cached.expiresAt - 300_000 > Date.now()) return cached.token;

  const assertion = await signServiceAccountJwt(key);
  const response = await fetch(key.token_uri ?? DEFAULT_TOKEN_URI, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  if (!response.ok) {
    throw new Error(`Google token exchange failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }
  const body = (await response.json()) as { access_token: string; expires_in: number };
  cached = { email: key.client_email, token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return body.access_token;
}

export function serviceAccountEmail(rawKey: string | undefined): string | null {
  try {
    return parseServiceAccountKey(rawKey).client_email;
  } catch {
    return null;
  }
}
