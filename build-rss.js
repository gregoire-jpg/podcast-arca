// build-rss.js — Génère rss.xml depuis episodes.json (exécuté par Netlify au build)
const fs = require("fs");

const config   = JSON.parse(fs.readFileSync("config.json",   "utf8"));
const episodes = JSON.parse(fs.readFileSync("episodes.json", "utf8"));
const pod      = config.podcast;
const seasons  = config.seasons || {};

function esc(str) {
  return String(str || "")
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;");
}

function rfc2822(iso) {
  return new Date(iso).toUTCString();
}

// Numérotation des épisodes par saison (ordre chronologique)
const episodeNumbers = {};
const bySlug = {};
episodes.forEach(ep => {
  const slug = ep.playlist_slug || "default";
  if (!bySlug[slug]) bySlug[slug] = [];
  bySlug[slug].push(ep);
});
Object.keys(bySlug).forEach(slug => {
  bySlug[slug]
    .sort((a, b) => new Date(a.published_at) - new Date(b.published_at))
    .forEach((ep, i) => { episodeNumbers[ep.youtube_id] = i + 1; });
});

const items = episodes
  .filter(ep => ep.audio_url)
  .map(ep => {
    const season    = seasons[ep.playlist_slug];
    const epNumber  = episodeNumbers[ep.youtube_id];
    const authorLabels = (ep.authors || [])
      .map(a => (config.authors || {})[a] || a)
      .join(", ");

    return `
    <item>
      <title>${esc(ep.title)}</title>
      <description><![CDATA[${ep.description || ""}]]></description>
      <enclosure url="${esc(ep.audio_url)}" length="${ep.file_size || 0}" type="audio/mpeg"/>
      <guid isPermaLink="false">${esc(ep.youtube_id)}</guid>
      <pubDate>${rfc2822(ep.published_at)}</pubDate>
      <itunes:duration>${esc(ep.duration_fmt)}</itunes:duration>
      <itunes:author>${esc(authorLabels)}</itunes:author>
      <itunes:subtitle>${esc(ep.playlist_title)}</itunes:subtitle>
      <itunes:episodeType>full</itunes:episodeType>
      ${ep.image_url ? `<itunes:image href="${esc(ep.image_url)}"/>` : ""}
      ${season    ? `<itunes:season>${season}</itunes:season>`       : ""}
      ${epNumber  ? `<itunes:episode>${epNumber}</itunes:episode>`   : ""}
    </item>`;
  })
  .join("");

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${esc(pod.title)}</title>
    <link>${esc(pod.website)}</link>
    <description>${esc(pod.description)}</description>
    <language>${pod.language}</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <itunes:author>${esc(pod.author)}</itunes:author>
    <itunes:subtitle>${esc(pod.subtitle)}</itunes:subtitle>
    <itunes:type>episodic</itunes:type>
    <itunes:owner>
      <itunes:name>${esc(pod.author)}</itunes:name>
      <itunes:email>${esc(pod.email)}</itunes:email>
    </itunes:owner>
    <itunes:image href="${esc(pod.image_url)}"/>
    <itunes:category text="${esc(pod.category)}"/>
    <itunes:explicit>false</itunes:explicit>
    ${items}
  </channel>
</rss>`;

fs.writeFileSync("rss.xml", xml, "utf8");

// Résumé par saison
const summary = {};
episodes.forEach(ep => {
  const s = seasons[ep.playlist_slug] || "?";
  summary[s] = (summary[s] || 0) + 1;
});
console.log(`✅ rss.xml généré — ${episodes.length} épisode(s)`);
Object.keys(summary).sort().forEach(s =>
  console.log(`   Saison ${s} : ${summary[s]} épisode(s)`)
);
