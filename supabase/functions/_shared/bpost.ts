// Utilitaires Bpost Shipping Manager Plug-in API v3 (porté depuis _bpost-utils.js).
// Auth : Basic base64(username:HMAC-SHA256(username+body, privateKey)) — HMAC via Web Crypto.

import { arcaEnv } from "./env.ts";
import { supaEnv } from "./supa.ts";

export const BPOST_BASE = "https://pluginsapi.bpost.be";
export const BPOST_APPID = "C6D32390-F48C-3D20-81F8-91932E7E4DE1"; // APPID Woo plugin officiel
const PLUGIN_VER = "3.2.3";
const PLATFORM_VER = "6.5";

function publicKey() { return arcaEnv("BPOST_SM_PUBLIC_KEY"); }
function privateKey() { return arcaEnv("BPOST_SM_PRIVATE_KEY"); }
export function supaUrl() { return supaEnv().url; }
export function supaKey() { return supaEnv().key; }

async function hmacBase64(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

export async function sign(username: string, body: string): Promise<string> {
  return await hmacBase64(privateKey(), username + body);
}

export async function basicAuth(username: string, body: string): Promise<string> {
  const sig = await sign(username, body);
  return "Basic " + btoa(username + ":" + sig);
}

async function fetchStoredToken(): Promise<any> {
  let r = await fetch(supaUrl() + "/rest/v1/arca_bpost_tokens?id=eq.1&select=token,expire_at,shop_url", {
    headers: { apikey: supaKey(), Authorization: "Bearer " + supaKey() },
  });
  if (!r.ok) {
    r = await fetch(supaUrl() + "/rest/v1/arca_bpost_tokens?id=eq.1&select=token,expire_at", {
      headers: { apikey: supaKey(), Authorization: "Bearer " + supaKey() },
    });
    if (!r.ok) return null;
  }
  const rows = await r.json();
  return (rows && rows[0]) || null;
}

async function saveToken(token: string, expire: string, shopUrl: string) {
  const fullBody = { token, expire_at: expire, shop_url: shopUrl || null, updated_at: new Date().toISOString() };
  const minimalBody = { token, expire_at: expire, updated_at: new Date().toISOString() };
  const url = supaUrl() + "/rest/v1/arca_bpost_tokens?id=eq.1";
  const hdrs = { apikey: supaKey(), Authorization: "Bearer " + supaKey(), "Content-Type": "application/json" };
  const r = await fetch(url, { method: "PATCH", headers: hdrs, body: JSON.stringify(fullBody) });
  if (!r.ok) {
    console.warn("[Bpost] PATCH avec shop_url KO (" + r.status + "), retry sans");
    await fetch(url, { method: "PATCH", headers: hdrs, body: JSON.stringify(minimalBody) });
  }
}

async function requestNewToken(shopUrl: string): Promise<any> {
  const body = JSON.stringify({ PluginVersion: PLUGIN_VER, ShopUrl: shopUrl, PlatformVersion: PLATFORM_VER });
  const r = await fetch(BPOST_BASE + "/v3/keys", {
    method: "POST",
    headers: { "X-APPID": BPOST_APPID, "Content-Type": "application/json", "Accept": "application/json", "Authorization": await basicAuth(publicKey(), body) },
    body,
  });
  const data = await r.json();
  if (!r.ok || !data.Key) throw new Error("Bpost /v3/keys failed: " + JSON.stringify(data).substring(0, 200));
  return { token: data.Key, expire: data.Expire };
}

export async function getValidToken(shopUrl: string): Promise<string> {
  const stored = await fetchStoredToken();
  const scopeMatches = stored && stored.shop_url === shopUrl;
  if (stored && stored.token && scopeMatches) {
    const expire = new Date(stored.expire_at + "T00:00:00Z");
    const limit = new Date(Date.now() + 2 * 24 * 3600 * 1000);
    if (expire > limit) return stored.token;
  }
  if (stored && !scopeMatches) console.log("[Bpost] ShopUrl changé → nouveau token");
  const fresh = await requestNewToken(shopUrl);
  await saveToken(fresh.token, fresh.expire, shopUrl);
  console.log("[Bpost] Token renouvelé pour ShopUrl=" + shopUrl + ", expire", fresh.expire);
  return fresh.token;
}

export async function bpostCall(method: string, path: string, body: any, token: string): Promise<any> {
  const bodyStr = body == null ? "" : (typeof body === "string" ? body : JSON.stringify(body));
  const r = await fetch(BPOST_BASE + path, {
    method,
    headers: { "X-APPID": BPOST_APPID, "Content-Type": "application/json", "Accept": "application/json", "Authorization": await basicAuth(token, bodyStr) },
    body: method === "GET" ? undefined : bodyStr,
  });
  const ctype = (r.headers.get("content-type") || "").toLowerCase();
  if (ctype.includes("application/pdf") || ctype.includes("octet-stream")) {
    const buf = new Uint8Array(await r.arrayBuffer());
    if (!r.ok) throw new Error("Bpost " + method + " " + path + " → HTTP " + r.status + " (binaire " + buf.length + "B)");
    return { __binary: true, contentType: ctype, buffer: buf };
  }
  const text = await r.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error("Bpost " + method + " " + path + " → HTTP " + r.status + ": " + JSON.stringify(data).substring(0, 300));
  return data;
}

export async function verifyCallbackSignature(receivedSig: string, status: string, trackingId: string, callbackUrl: string): Promise<boolean> {
  const expected = await hmacBase64(privateKey(), status + "," + trackingId + "," + callbackUrl);
  if (receivedSig.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= receivedSig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
