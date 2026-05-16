#!/usr/bin/env python3
"""
sync.py — YouTube (chaîne complète) → Dropbox → episodes.json

Usage:
  python scripts/sync.py           # Mode normal  : 15 dernières vidéos par playlist + orphelines classées
  python scripts/sync.py --init    # Mode initial : TOUTES les vidéos (run une seule fois)

Playlists découvertes automatiquement depuis la chaîne YouTube.
Seules les playlists listées dans "exclude_playlists" sont ignorées.

ORPHELINES : après la passe playlists, le script scanne la playlist auto "uploads"
(UC -> UU) et détecte les vidéos qui ne sont dans aucune playlist thématique.
Il importe celles listées dans orphans.json (avec leur classification éditoriale)
et liste celles qui restent à classer.

Format orphans.json :
  [{ "youtube_id": "...",
     "playlist_slug":  "entretiens-stephane-feye",
     "playlist_title": "Entretiens avec Stéphane Feye",
     "playlist_id":    "",         // vide si aucune playlist YT correspondante
     "authors":        ["stephane-feye"],
     "subject":        "entretiens" }]
"""

import os, sys, json, subprocess, tempfile, time, re
import xml.etree.ElementTree as ET
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

try:
    import dropbox
    from dropbox.exceptions import ApiError
    from dropbox.files import WriteMode
except ImportError:
    print("❌  pip install yt-dlp dropbox")
    sys.exit(1)

ROOT          = Path(__file__).parent.parent
CONFIG_FILE   = ROOT / "config.json"
EPISODES_FILE = ROOT / "episodes.json"
ORPHANS_FILE  = ROOT / "orphans.json"   # mapping youtube_id -> classification éditoriale
DROPBOX_DIR   = "/Podcast ARCA"

# ──────────────────── Utilitaires ────────────────────

def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def slugify(text):
    text = text.lower()
    for a, b in [("àâä","a"),("éèêë","e"),("îï","i"),("ôö","o"),("ùûü","u"),("ç","c")]:
        for c in a:
            text = text.replace(c, b)
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text

def fmt_duration(seconds):
    if not seconds:
        return "0:00"
    h, r = divmod(int(seconds), 3600)
    m, s = divmod(r, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"

# ──────────────────── Dropbox ────────────────────────

def make_dbx():
    return dropbox.Dropbox(
        oauth2_refresh_token = os.environ["DROPBOX_REFRESH_TOKEN"],
        app_key              = os.environ["DROPBOX_APP_KEY"],
        app_secret           = os.environ["DROPBOX_APP_SECRET"],
    )

CHUNK_SIZE = 40 * 1024 * 1024  # 40 MB par chunk

def upload_to_dropbox(dbx, local_path, filename):
    remote    = f"{DROPBOX_DIR}/{filename}"
    file_size = os.path.getsize(local_path)

    with open(local_path, "rb") as f:
        if file_size <= CHUNK_SIZE:
            dbx.files_upload(f.read(), remote, mode=WriteMode.overwrite)
        else:
            # Upload par morceaux pour les gros fichiers
            session = dbx.files_upload_session_start(f.read(CHUNK_SIZE))
            cursor  = dropbox.files.UploadSessionCursor(
                session_id=session.session_id, offset=f.tell()
            )
            commit = dropbox.files.CommitInfo(path=remote, mode=WriteMode.overwrite)
            while f.tell() < file_size:
                remaining = file_size - f.tell()
                if remaining <= CHUNK_SIZE:
                    dbx.files_upload_session_finish(f.read(CHUNK_SIZE), cursor, commit)
                else:
                    dbx.files_upload_session_append_v2(f.read(CHUNK_SIZE), cursor)
                    cursor.offset = f.tell()

    try:
        res = dbx.sharing_create_shared_link_with_settings(remote)
    except ApiError as e:
        if e.error.is_shared_link_already_exists():
            res = dbx.sharing_list_shared_links(path=remote).links[0]
        else:
            raise
    return res.url.replace("www.dropbox.com", "dl.dropboxusercontent.com").replace("?dl=0", "")

# ──────────────────── Découverte YouTube ─────────────

def discover_playlists(channel_id, exclude_titles):
    """
    Récupère toutes les playlists publiques de la chaîne via yt-dlp.
    Aucune clé API requise.
    """
    url = f"https://www.youtube.com/channel/{channel_id}/playlists"
    print(f"🔍 Découverte des playlists sur la chaîne…")

    res = subprocess.run(
        [sys.executable, "-m", "yt_dlp", "-J", "--flat-playlist", "--no-warnings", url],
        capture_output=True, text=True, timeout=120,
    )
    if res.returncode != 0:
        print(f"  ⚠  yt-dlp error: {res.stderr[:200]}")
        return []

    try:
        data = json.loads(res.stdout)
    except json.JSONDecodeError:
        print("  ⚠  Impossible de parser la réponse yt-dlp")
        return []

    playlists = []
    for entry in data.get("entries", []):
        pl_id    = entry.get("id", "")
        pl_title = entry.get("title", "")
        if not pl_id or pl_title in exclude_titles:
            print(f"  ⏭  Ignorée : {pl_title}")
            continue
        playlists.append({"id": pl_id, "title": pl_title})
        print(f"  ✓  {pl_title} ({pl_id})")

    return playlists

def rss_videos(playlist_id):
    """15 dernières vidéos via le flux RSS public (sans clé API)."""
    url = f"https://www.youtube.com/feeds/videos.xml?playlist_id={playlist_id}"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            root = ET.fromstring(r.read())
        ns = {"yt": "http://www.youtube.com/xml/schemas/2015",
              "atom": "http://www.w3.org/2005/Atom"}
        return [
            {"id": e.find("yt:videoId", ns).text, "title": e.find("atom:title", ns).text}
            for e in root.findall("atom:entry", ns)
        ]
    except Exception as exc:
        print(f"  ⚠  RSS inaccessible: {exc}")
        return []

def all_videos(playlist_id):
    """Toutes les vidéos d'une playlist via yt-dlp (mode --init)."""
    res = subprocess.run(
        [sys.executable, "-m", "yt_dlp", "--flat-playlist", "--print", "%(id)s\t%(title)s",
         "--no-warnings", f"https://www.youtube.com/playlist?list={playlist_id}"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    videos = []
    for line in (res.stdout or "").strip().splitlines():
        parts = line.split("\t", 1)
        if len(parts) == 2:
            videos.append({"id": parts[0], "title": parts[1]})
    return videos

def uploads_videos(channel_id):
    """Toutes les vidéos de la chaîne via la playlist auto 'uploads' (UC -> UU)."""
    uploads_id = "UU" + channel_id[2:]
    return all_videos(uploads_id)

# ──────────────────── Traitement vidéo ───────────────

def process_video(video_id, pl_title, pl_slug, pl_meta):
    yt_url = f"https://www.youtube.com/watch?v={video_id}"

    with tempfile.TemporaryDirectory() as tmp:
        out_tpl = os.path.join(tmp, "%(id)s.%(ext)s")
        res = subprocess.run(
            [sys.executable, "-m", "yt_dlp",
             "--format", "bestaudio/best",
             "--extract-audio", "--audio-format", "mp3", "--audio-quality", "5",
             "--output", out_tpl,
             "--print-json", "--no-warnings",
             yt_url],
            capture_output=True, text=True,
        )
        if res.returncode != 0:
            print(f"  ❌  yt-dlp: {res.stderr[:150]}")
            return None

        try:
            meta = json.loads(res.stdout.strip().splitlines()[0])
        except Exception:
            meta = {}

        mp3_files = list(Path(tmp).glob("*.mp3"))
        if not mp3_files:
            print(f"  ❌  MP3 introuvable pour {video_id}")
            return None

        mp3_path  = str(mp3_files[0])
        file_size = os.path.getsize(mp3_path)

        print(f"  ☁  Upload Dropbox…")
        audio_url = upload_to_dropbox(make_dbx(), mp3_path, f"{video_id}.mp3")

    raw_date = meta.get("upload_date", "")
    published = (
        f"{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:8]}T00:00:00+00:00"
        if len(raw_date) == 8
        else datetime.now(timezone.utc).isoformat()
    )

    return {
        "youtube_id":     video_id,
        "playlist_id":    pl_meta.get("_id", ""),
        "playlist_title": pl_title,
        "playlist_slug":  pl_slug,
        "title":          meta.get("title", ""),
        "description":    meta.get("description", ""),
        "published_at":   published,
        "duration":       meta.get("duration", 0),
        "duration_fmt":   fmt_duration(meta.get("duration", 0)),
        "audio_url":      audio_url,
        "file_size":      file_size,
        "image_url":      meta.get("thumbnail", ""),
        "authors":        pl_meta.get("authors", []),
        "subject":        pl_meta.get("subject", ""),
    }

# ──────────────────── Main ───────────────────────────

def main():
    init_mode = "--init" in sys.argv

    config   = load_json(CONFIG_FILE)
    episodes = load_json(EPISODES_FILE)
    seen_ids = {ep["youtube_id"] for ep in episodes}

    channel_id      = config["channel_id"]
    exclude_titles  = set(config.get("exclude_playlists", []))
    pl_meta_map     = config.get("playlist_metadata", {})

    # ── Découverte automatique des playlists ──
    playlists = discover_playlists(channel_id, exclude_titles)
    if not playlists:
        print("❌  Aucune playlist trouvée.")
        sys.exit(1)

    print(f"\n{len(playlists)} playlist(s) à synchroniser\n")
    added = 0

    for pl in playlists:
        pl_id   = pl["id"]
        pl_title = pl["title"]
        pl_slug  = slugify(pl_title)
        pl_meta  = pl_meta_map.get(pl_id, {})
        pl_meta["_id"] = pl_id

        print(f"📋 {pl_title}")
        videos = all_videos(pl_id) if init_mode else rss_videos(pl_id)
        print(f"  {len(videos)} vidéo(s)")

        for vid in videos:
            if vid["id"] in seen_ids:
                print(f"  ✓  {vid['title'][:55]}")
                continue

            print(f"  ⬇  {vid['title'][:55]}")
            ep = process_video(vid["id"], pl_title, pl_slug, pl_meta)
            if ep:
                episodes.append(ep)
                seen_ids.add(vid["id"])
                save_json(EPISODES_FILE, sorted(
                    episodes, key=lambda e: e.get("published_at", ""), reverse=True
                ))
                added += 1
                print(f"  ✅ {ep['title'][:55]}")
            time.sleep(1)

    # ── Orphelines : vidéos uploadées sur la chaîne mais dans aucune playlist thématique ──
    print(f"\n🔎 Scan vidéos orphelines (uploads sans playlist thématique)…")
    all_uploads = uploads_videos(channel_id)
    orphans = [v for v in all_uploads if v["id"] not in seen_ids]

    if orphans:
        orphans_meta = {}
        if ORPHANS_FILE.exists():
            for entry in load_json(ORPHANS_FILE):
                orphans_meta[entry["youtube_id"]] = entry

        to_import   = [v for v in orphans if v["id"] in orphans_meta]
        to_classify = [v for v in orphans if v["id"] not in orphans_meta]

        print(f"  {len(orphans)} orpheline(s) totales · {len(to_import)} classée(s) · {len(to_classify)} à classer")

        for vid in to_import:
            m = orphans_meta[vid["id"]]
            pl_title = m["playlist_title"]
            pl_slug  = m["playlist_slug"]
            pl_meta  = {
                "_id":     m.get("playlist_id", ""),
                "authors": m.get("authors", []),
                "subject": m.get("subject", ""),
            }
            print(f"  ⬇  [orpheline] {vid['title'][:55]}  →  {pl_slug}")
            ep = process_video(vid["id"], pl_title, pl_slug, pl_meta)
            if ep:
                episodes.append(ep)
                seen_ids.add(vid["id"])
                save_json(EPISODES_FILE, sorted(
                    episodes, key=lambda e: e.get("published_at", ""), reverse=True
                ))
                added += 1
                print(f"  ✅ {ep['title'][:55]}")
            time.sleep(1)

        if to_classify:
            print(f"\n⏸  {len(to_classify)} orpheline(s) en attente de classement (ajouter à {ORPHANS_FILE.name}) :")
            for vid in to_classify:
                print(f"    - [{vid['id']}] {vid['title'][:75]}")
    else:
        print("  Aucune orpheline.")

    episodes.sort(key=lambda e: e.get("published_at", ""), reverse=True)
    save_json(EPISODES_FILE, episodes)
    print(f"\n✅  {added} nouvel(s) épisode(s) ajouté(s).")

if __name__ == "__main__":
    main()
