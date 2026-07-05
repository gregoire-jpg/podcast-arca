// Helpers e-mail ARCA (Brevo) — partagés (porté depuis netlify/functions/_arca-mail.js).
// Réutilise la même config que les autres functions : ARCA_BREVO_API_KEY + ARCA_ORDER_EMAIL_FROM.

import { arcaEnv } from "./env.ts";

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";

// Échappe une valeur destinée à être interpolée dans du HTML d'email (anti-injection).
export function esc(s: any) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function arcaTitle(num: any) {
  return Number(num) === 9 ? "le Recueil de prières" : ("la revue ARCA n°" + num);
}
export function arcaShort(num: any) {
  return Number(num) === 9 ? "Recueil de prières" : ("ARCA n°" + num);
}

export function wrapHtml(bodyHtml: string) {
  return '<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#23264a">'
    + '<div style="background:#23264a;padding:18px 24px;border-radius:6px 6px 0 0">'
      + '<span style="color:#c8a060;font:bold 20px Georgia;letter-spacing:3px">ARCA</span>'
    + "</div>"
    + '<div style="border:1px solid #e6e2d8;border-top:none;border-radius:0 0 6px 6px;padding:24px;font-size:15px;line-height:1.6">'
      + bodyHtml
    + "</div>"
    + '<div style="text-align:center;color:#999;font:12px Arial;padding:14px 0">Arca Societas SRL · Rue du Lambais 70 · 1390 Grez-Doiceau</div>'
  + "</div>";
}

export function fromEmail() {
  return arcaEnv("ORDER_EMAIL_FROM") || "";
}

// Envoi d'un e-mail via Brevo. Lève une erreur si la réponse n'est pas OK.
export async function sendBrevo(payload: unknown) {
  const apiKey = arcaEnv("BREVO_API_KEY");
  if (!apiKey) throw new Error("BREVO_API_KEY manquante");
  const resp = await fetch(BREVO_URL, {
    method: "POST",
    headers: { accept: "application/json", "api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error("Brevo " + resp.status + ": " + (await resp.text()));
  return resp.json().catch(() => ({}));
}
