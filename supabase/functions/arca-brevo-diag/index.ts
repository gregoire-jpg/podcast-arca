// Edge Function — diagnostic Brevo (ADMIN). (Portée depuis netlify/functions/brevo-diag.js.)
// GET ?token=<ADMIN_PASSWORD>[&email=...] → account / senders / domains / events. Ne renvoie jamais la clé.

import { timingSafeEqual } from "../_shared/auth.ts";
import { arcaEnv } from "../_shared/env.ts";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
  });
}

Deno.serve(async (req) => {
  const KEY = arcaEnv("BREVO_API_KEY");
  const ADMIN = arcaEnv("ADMIN_PASSWORD");
  if (!KEY) return json(500, { error: "BREVO_API_KEY missing" });
  if (!ADMIN) return json(500, { error: "ADMIN_PASSWORD missing (cannot gate)" });

  const q = new URL(req.url).searchParams;
  if (!timingSafeEqual(q.get("token") || "", ADMIN)) return json(401, { error: "Bad token" });

  const filterEmail = (q.get("email") || "").trim();
  const hdrs = { "accept": "application/json", "api-key": KEY };
  const out: any = {};

  try {
    const r = await fetch("https://api.brevo.com/v3/account", { headers: hdrs });
    out.account_status = r.status;
    if (r.ok) {
      const a = await r.json();
      out.account = {
        email: a.email,
        plan: (a.plan || []).map((p: any) => ({ type: p.type, credits: p.credits, credits_type: p.creditsType })),
        marketing_automation: a.marketingAutomation, company: a.companyName,
      };
    } else out.account_error = await r.text();
  } catch (e) { out.account_error = (e as Error).message; }

  try {
    const r = await fetch("https://api.brevo.com/v3/senders", { headers: hdrs });
    if (r.ok) {
      const s = await r.json();
      out.senders = (s.senders || []).map((x: any) => ({ name: x.name, email: x.email, active: x.active }));
    } else out.senders_error = await r.text();
  } catch (e) { out.senders_error = (e as Error).message; }

  try {
    const r = await fetch("https://api.brevo.com/v3/senders/domains", { headers: hdrs });
    if (r.ok) {
      const d = await r.json();
      out.domains = (d.domains || []).map((x: any) => ({ domain: x.domain || x.domain_name, authenticated: x.authenticated, verified: x.verified }));
    }
  } catch (_e) { /* optionnel */ }

  try {
    const params = new URLSearchParams({ limit: "50", offset: "0", days: "14" });
    if (filterEmail) params.set("email", filterEmail);
    const r = await fetch(`https://api.brevo.com/v3/smtp/statistics/events?${params}`, { headers: hdrs });
    if (r.ok) {
      const e = await r.json();
      const events = (e.events || []).slice(0, 30).map((ev: any) => ({
        date: ev.date, event: ev.event, email: ev.email, reason: ev.reason,
        subject: ev.subject, message_id: ev.messageId, from: ev.from, ip: ev.ip,
      }));
      out.events = events;
      out.events_count = events.length;
      const byEvent: any = {};
      events.forEach((ev: any) => { byEvent[ev.event] = (byEvent[ev.event] || 0) + 1; });
      out.events_summary = byEvent;
    } else out.events_error = await r.text();
  } catch (e) { out.events_error = (e as Error).message; }

  return json(200, out);
});
