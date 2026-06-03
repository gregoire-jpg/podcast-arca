// Diagnostic Brevo — pourquoi les mails ne sont pas livrés alors que l'API
// répond 2xx. Lit l'API key depuis env, interroge /v3/account et
// /v3/smtp/statistics/events, expose un JSON synthétique.
//
// Gated par ?token=<ADMIN_PASSWORD>. Ne renvoie JAMAIS la clé Brevo.
//
// GET /.netlify/functions/brevo-diag?token=XXX[&email=test@example.com]
//   - account     : crédits, plan, statut
//   - senders     : adresses validées (DKIM/SPF)
//   - events      : 20 derniers événements SMTP (sent, delivered, bounced, blocked, etc.)
//   - if ?email   : filtre les events par destinataire

exports.handler = async function (event) {
  const KEY = process.env.BREVO_API_KEY;
  const ADMIN = process.env.ADMIN_PASSWORD;
  if (!KEY)   return json(500, { error: 'BREVO_API_KEY missing' });
  if (!ADMIN) return json(500, { error: 'ADMIN_PASSWORD missing (cannot gate)' });

  const q = event.queryStringParameters || {};
  if (q.token !== ADMIN) return json(401, { error: 'Bad token' });

  const filterEmail = (q.email || '').trim();

  const hdrs = {
    'accept': 'application/json',
    'api-key': KEY,
  };

  const out = {};

  // 1. Account info
  try {
    const r = await fetch('https://api.brevo.com/v3/account', { headers: hdrs });
    out.account_status = r.status;
    if (r.ok) {
      const a = await r.json();
      out.account = {
        email: a.email,
        plan: (a.plan || []).map(p => ({ type: p.type, credits: p.credits, credits_type: p.creditsType })),
        marketing_automation: a.marketingAutomation,
        company: a.companyName,
      };
    } else {
      out.account_error = await r.text();
    }
  } catch (e) { out.account_error = e.message; }

  // 2. Senders
  try {
    const r = await fetch('https://api.brevo.com/v3/senders', { headers: hdrs });
    if (r.ok) {
      const s = await r.json();
      out.senders = (s.senders || []).map(x => ({
        name: x.name,
        email: x.email,
        active: x.active,
        ips: (x.ips || []).map(i => ({ ip: i.ip, weight: i.weight })),
      }));
    } else {
      out.senders_error = await r.text();
    }
  } catch (e) { out.senders_error = e.message; }

  // 3. Domains (SPF/DKIM verification)
  try {
    const r = await fetch('https://api.brevo.com/v3/senders/domains', { headers: hdrs });
    if (r.ok) {
      const d = await r.json();
      out.domains = (d.domains || []).map(x => ({
        domain: x.domain,
        authenticated: x.authenticated,
        verified: x.verified,
      }));
    }
  } catch (e) { /* ignore — endpoint optional */ }

  // 4. Recent events (sent / delivered / bounced / blocked / hardbounced / softbounced / spam)
  // Tris du plus récent au plus ancien. limit=50.
  try {
    const params = new URLSearchParams({
      limit: '50',
      offset: '0',
      days: '14',
    });
    if (filterEmail) params.set('email', filterEmail);
    const r = await fetch(`https://api.brevo.com/v3/smtp/statistics/events?${params}`, { headers: hdrs });
    if (r.ok) {
      const e = await r.json();
      const events = (e.events || []).slice(0, 30).map(ev => ({
        date: ev.date,
        event: ev.event,         // sent, delivered, bounced, blocked, spam, etc.
        email: ev.email,
        reason: ev.reason,       // raison du blocage le cas échéant
        subject: ev.subject,
        message_id: ev.messageId,
        from: ev.from,
        ip: ev.ip,
      }));
      out.events = events;
      out.events_count = events.length;

      // Synthèse : compte par type d'événement
      const byEvent = {};
      events.forEach(ev => { byEvent[ev.event] = (byEvent[ev.event] || 0) + 1; });
      out.events_summary = byEvent;
    } else {
      out.events_error = await r.text();
    }
  } catch (e) { out.events_error = e.message; }

  // 5. Liste des blocked contacts (blacklist auto-générée par Brevo)
  try {
    const r = await fetch('https://api.brevo.com/v3/contacts/lists/blacklisted?limit=20&offset=0', { headers: hdrs });
    if (r.ok) {
      const b = await r.json();
      out.blacklisted_count = b.count || 0;
    }
  } catch (e) { /* ignore */ }

  return json(200, out);
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body, null, 2),
  };
}
