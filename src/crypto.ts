// Small helpers: random values, PKCE, and encryption of the tokens kept in D1.

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function s256(text: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

const keyCache = new Map<string, Promise<CryptoKey>>();

// An AES-GCM key derived from SESSION_SECRET, so the deployment has one secret to set.
// Changing SESSION_SECRET signs everyone out and makes the stored connections unreadable
// (they are connected again from the connections page).
function tokenKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = (async () => {
      const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
      return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode("heddleway-calendar tokens v1") },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    keyCache.set(secret, key);
  }
  return key;
}

export async function seal(secret: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await tokenKey(secret), new TextEncoder().encode(plain)));
  return `${b64url(iv)}.${b64url(data)}`;
}

export async function open(secret: string, sealed: string): Promise<string> {
  const [iv, data] = sealed.split(".");
  if (!iv || !data) throw new Error("malformed sealed value");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(iv) }, await tokenKey(secret), fromB64url(data));
  return new TextDecoder().decode(plain);
}
