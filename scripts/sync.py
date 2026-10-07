#!/usr/bin/env python3
"""
sync.py — YouTube (chaîne complète) → Dropbox → episodes.json

Usage:
  python scripts/sync.py           # Mode normal  : 15 dernières vidéos par playlist + orphelines classées
  python scripts/sync.py --init    # Mode initial : TOUTES les vidéos (run une seule fois)
  python scripts/sync.py --pc1     # Sur PC1 : télécharge et dépose MP3 + fiche dans le
                                   # dossier Dropbox local ; le run GitHub publie l'épisode
                                   # (YouTube bloque les téléchargements depuis GitHub).
                                   # Lancé par la tâche planifiée « Sync podcasts ARCA »
                                   # (scripts/sync-pc1.ps1).

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

import os, sys, json, subprocess, tempfile, time, re, shutil
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

# ──────────────────── yt-dlp helpers ─────────────────

def yt_dlp_base_args():
    """
    Arguments communs à tous les appels yt-dlp :
    - métadonnées en français (sans quoi YouTube renvoie les titres traduits
      automatiquement dans la langue du runner, ex. « The Found Message… ») ;
    - moteur JS (yt-dlp >= 2025.11 en a besoin pour YouTube) si node est là ;
    - cookies anti bot-gate si fournis.
    """
    args = ["--no-warnings", "--extractor-args", "youtube:lang=fr"]
    if shutil.which("node"):
        args += ["--js-runtimes", "node"]
    return args + yt_dlp_cookie_args()

BOT_GATE = "confirm you"   # « Sign in to confirm you’re not a bot »
NOT_YET_PUBLIC = ("video unavailable", "vidéo non disponible", "private video", "vidéo privée",
                  "live event will begin", "premieres in", "premiere will begin")
FAILURES = []              # (video_id, raison) — fait échouer le run à la fin

def yt_dlp_cookie_args():
    """
    Retourne les args yt-dlp pour passer un fichier de cookies si
    YT_COOKIES_FILE est défini dans l'env (format Netscape cookies.txt).
    Utilisé pour contourner le bot-gate YouTube sur GitHub Actions.
    Comportement inchangé en local si la variable n'est pas posée.
    """
    cookies_path = os.environ.get("YT_COOKIES_FILE", "").strip()
    if cookies_path and os.path.isfile(cookies_path):
        return ["--cookies", cookies_path]
    return []

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
    # Mode 1 (CI / long terme) : refresh token + app key/secret
    if "DROPBOX_REFRESH_TOKEN" in os.environ:
        return dropbox.Dropbox(
            oauth2_refresh_token = os.environ["DROPBOX_REFRESH_TOKEN"],
            app_key              = os.environ["DROPBOX_APP_KEY"],
            app_secret           = os.environ["DROPBOX_APP_SECRET"],
        )
    # Mode 2 (one-shot local) : access token court (~4h)
    if "DROPBOX_ACCESS_TOKEN" in os.environ:
        return dropbox.Dropbox(os.environ["DROPBOX_ACCESS_TOKEN"])
    raise RuntimeError("Aucun credential Dropbox dans l'env (DROPBOX_REFRESH_TOKEN+APP_KEY+APP_SECRET, ou DROPBOX_ACCESS_TOKEN).")

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

    return shared_link(dbx, remote)

def shared_link(dbx, remote):
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
        [sys.executable, "-m", "yt_dlp", "-J", "--flat-playlist", *yt_dlp_base_args(), url],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180,
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
        # Le flux RSS YouTube tombe régulièrement en 404/500 : on se rabat sur
        # yt-dlp (mêmes 15 dernières) plutôt que de sauter la playlist.
        print(f"  ⚠  RSS inaccessible ({exc}) — repli sur yt-dlp")
        return all_videos(playlist_id, limit=15)

def all_videos(playlist_id, limit=None):
    """Toutes les vidéos d'une playlist via yt-dlp (mode --init, ou repli RSS)."""
    extra = ["--playlist-end", str(limit)] if limit else []
    res = subprocess.run(
        [sys.executable, "-m", "yt_dlp", "--flat-playlist", "--print", "%(id)s\t%(title)s",
         *extra, *yt_dlp_base_args(),
         f"https://www.youtube.com/playlist?list={playlist_id}"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300,
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

# ──────────────────── Dépôt PC1 ──────────────────────
#
# YouTube bloque les téléchargements depuis les runners GitHub (bot-gate).
# PC1 (IP résidentielle) lance `sync.py --pc1` : il télécharge l'audio et dépose
# <id>.mp3 + <id>.json (fiche de métadonnées) dans le dossier Dropbox de l'app,
# synchronisé localement. Le run GitHub, qui a les clés Dropbox, trouve le dépôt,
# crée le lien de partage et ajoute l'épisode — sans rien télécharger.

LOCAL_DIR      = None    # mode --pc1 : dossier Dropbox local (…/Applications/Podcast ARCA/Podcast ARCA)
HEARTBEAT      = "_pc1.json"
HEARTBEAT_DAYS = 3       # au-delà, un dépôt en attente fait passer le run GitHub en rouge
DEPOSITED      = []      # mode --pc1 : vidéos déposées ce passage
PENDING        = []      # mode GitHub : vidéos bloquées par YouTube, en attente du dépôt PC1

def find_local_dir():
    env = os.environ.get("PODCAST_DROPBOX_DIR", "").strip()
    if env:
        return Path(env)
    info = Path(os.environ.get("LOCALAPPDATA", "")) / "Dropbox" / "info.json"
    if info.exists():
        for acc in json.loads(info.read_text(encoding="utf-8")).values():
            d = Path(acc.get("path", "")) / "Applications" / "Podcast ARCA" / DROPBOX_DIR.strip("/")
            if d.is_dir():
                return d
    raise RuntimeError("Dossier Dropbox « Applications/Podcast ARCA/Podcast ARCA » introuvable "
                       "(définir PODCAST_DROPBOX_DIR).")

def sidecar_meta(meta, file_size):
    """Ce que le run GitHub relit pour construire l'épisode (format yt-dlp réduit)."""
    return {
        "id":          meta.get("id", ""),
        "title":       meta.get("title", ""),
        "description": meta.get("description", ""),
        "upload_date": meta.get("upload_date", ""),
        "duration":    meta.get("duration", 0),
        "thumbnails":  [{"url": t.get("url", "")} for t in meta.get("thumbnails") or []
                        if "i.ytimg.com/vi/" in (t.get("url") or "")],
        "bytes":       file_size,
    }

def prefetched(video_id):
    """Dépôt PC1 complet sur Dropbox ? → (meta, taille, lien), sinon None."""
    dbx = make_dbx()
    mp3 = f"{DROPBOX_DIR}/{video_id}.mp3"
    try:
        _, resp = dbx.files_download(f"{DROPBOX_DIR}/{video_id}.json")
        meta = json.loads(resp.content.decode("utf-8"))
        md = dbx.files_get_metadata(mp3)
    except ApiError:
        return None
    if getattr(md, "size", -1) != meta.get("bytes"):
        print(f"  …  dépôt PC1 de {video_id} pas encore entièrement synchronisé")
        return None
    return meta, md.size, shared_link(dbx, mp3)

def pc1_heartbeat_age_days():
    try:
        _, resp = make_dbx().files_download(f"{DROPBOX_DIR}/{HEARTBEAT}")
        at = datetime.fromisoformat(json.loads(resp.content.decode("utf-8"))["at"])
        return (datetime.now(timezone.utc) - at).total_seconds() / 86400
    except Exception:
        return None

def process_video(video_id, pl_title, pl_slug, pl_meta):
    yt_url = f"https://www.youtube.com/watch?v={video_id}"

    if LOCAL_DIR is None:
        pre = prefetched(video_id)
        if pre:
            meta, file_size, audio_url = pre
            print(f"  📥  Dépôt PC1 trouvé sur Dropbox")
            return build_episode(video_id, meta, pl_title, pl_slug, pl_meta, audio_url, file_size)
    else:
        mp3_local, js_local = LOCAL_DIR / f"{video_id}.mp3", LOCAL_DIR / f"{video_id}.json"
        if mp3_local.exists() and js_local.exists():
            print(f"  ✓  déjà déposé, en attente du run GitHub")
            return None

    with tempfile.TemporaryDirectory() as tmp:
        out_tpl = os.path.join(tmp, "%(id)s.%(ext)s")
        for attempt in range(2):   # 403 passagers sur les flux audio YouTube : une seconde chance
            res = subprocess.run(
                [sys.executable, "-m", "yt_dlp",
                 "--format", "bestaudio/best",
                 "--extract-audio", "--audio-format", "mp3", "--audio-quality", "5",
                 "--output", out_tpl,
                 "--print-json",
                 *yt_dlp_base_args(),
                 yt_url],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800,
            )
            if res.returncode == 0 or BOT_GATE in (res.stderr or ""):
                break
            time.sleep(10)
        if res.returncode != 0:
            err = (res.stderr or "").strip()
            if any(m in err.lower() for m in NOT_YET_PUBLIC):
                # Privée, programmée ou direct à venir mais déjà listée dans la playlist :
                # rien d'anormal, elle sera reprise au passage où elle deviendra publique.
                print(f"  …  pas encore publique — reprise plus tard")
                return None
            if BOT_GATE in err and LOCAL_DIR is None:
                print(f"  ⏸  bloquée par YouTube — en attente du dépôt PC1")
                PENDING.append(video_id)
                return None
            print(f"  ❌  yt-dlp: {err[:150]}")
            FAILURES.append((video_id, "bot-gate" if BOT_GATE in err else err[:120]))
            return None

        try:
            meta = json.loads(res.stdout.strip().splitlines()[0])
        except Exception:
            meta = {}

        mp3_files = list(Path(tmp).glob("*.mp3"))
        if not mp3_files:
            print(f"  ❌  MP3 introuvable pour {video_id}")
            FAILURES.append((video_id, "MP3 introuvable"))
            return None

        mp3_path  = str(mp3_files[0])
        file_size = os.path.getsize(mp3_path)

        if LOCAL_DIR is not None:
            # MP3 d'abord (via .part pour ne jamais exposer un fichier tronqué),
            # fiche ensuite : le run GitHub exige les deux, tailles concordantes.
            part = LOCAL_DIR / f"{video_id}.mp3.part"
            shutil.copyfile(mp3_path, part)
            os.replace(part, LOCAL_DIR / f"{video_id}.mp3")
            meta.setdefault("id", video_id)
            save_json(LOCAL_DIR / f"{video_id}.json", sidecar_meta(meta, file_size))
            DEPOSITED.append(video_id)
            print(f"  📤  Déposé dans Dropbox ({file_size // 1024} Ko)")
            return None

        print(f"  ☁  Upload Dropbox…")
        audio_url = upload_to_dropbox(make_dbx(), mp3_path, f"{video_id}.mp3")

    return build_episode(video_id, meta, pl_title, pl_slug, pl_meta, audio_url, file_size)

def build_episode(video_id, meta, pl_title, pl_slug, pl_meta, audio_url, file_size):
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
        "image_url":      stable_thumb(video_id, meta),
        "authors":        detect_authors(meta, pl_meta),
        "subject":        pl_meta.get("subject", ""),
    }

def stable_thumb(video_id, meta):
    """Miniature à URL stable (celles de yt-dlp portent parfois des paramètres signés)."""
    urls = {t.get("url", "") for t in meta.get("thumbnails") or []}
    for name in ("maxresdefault.jpg", "sddefault.jpg"):
        u = f"https://i.ytimg.com/vi/{video_id}/{name}"
        if u in urls:
            return u
    return f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"

AUTHOR_NAMES = {}   # clé auteur -> nom affiché, rempli depuis config.json

def detect_authors(meta, pl_meta):
    """
    Auteurs cités nommément dans le titre (puis la description) parmi ceux de
    config.json ; à défaut, les auteurs par défaut de la playlist.
    Évite les épisodes « sans auteur » dans les playlists à intervenants multiples.
    """
    for field in ("title", "description"):
        text = (meta.get(field) or "").lower()
        found = [k for k, name in AUTHOR_NAMES.items() if name and name.lower() in text]
        if found:
            return found
    return list(pl_meta.get("authors", []))

# ──────────────────── Main ───────────────────────────

def main():
    global LOCAL_DIR
    init_mode = "--init" in sys.argv
    if "--pc1" in sys.argv:
        LOCAL_DIR = find_local_dir()
        print(f"🖥  Mode PC1 : dépôt dans {LOCAL_DIR}")

    config   = load_json(CONFIG_FILE)
    episodes = load_json(EPISODES_FILE)
    seen_ids = {ep["youtube_id"] for ep in episodes}

    channel_id      = config["channel_id"]
    exclude_titles  = set(config.get("exclude_playlists", []))
    exclude_videos  = set(config.get("exclude_videos", []))
    pl_meta_map     = config.get("playlist_metadata", {})
    AUTHOR_NAMES.update(config.get("authors", {}))

    # Slug stable par playlist : si la playlist YouTube est renommée, on garde
    # le slug déjà porté par ses épisodes (sinon la playlist se scinde en deux).
    # Slug majoritaire : un épisode déplacé à la main dans une autre playlist ne
    # doit pas entraîner le reste de sa playlist YouTube.
    slug_votes = {}
    for ep in episodes:
        if ep.get("playlist_id"):
            votes = slug_votes.setdefault(ep["playlist_id"], {})
            votes[ep["playlist_slug"]] = votes.get(ep["playlist_slug"], 0) + 1
    known_slug = {pid: max(v, key=v.get) for pid, v in slug_votes.items()}
    in_playlists = set()   # toutes les vidéos présentes dans une playlist thématique

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
        pl_slug  = known_slug.get(pl_id) or slugify(pl_title)
        pl_meta  = dict(pl_meta_map.get(pl_id, {}), _id=pl_id)

        print(f"📋 {pl_title}")
        videos = all_videos(pl_id) if init_mode else rss_videos(pl_id)
        print(f"  {len(videos)} vidéo(s)")

        for vid in videos:
            in_playlists.add(vid["id"])
            if vid["id"] in seen_ids:
                print(f"  ✓  {vid['title'][:55]}")
                continue
            if vid["id"] in exclude_videos:
                print(f"  🚫  [exclu] {vid['title'][:55]}")
                seen_ids.add(vid["id"])  # marquer comme vu pour ignorer aussi en orpheline
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
    # Une vidéo de playlist dont le téléchargement a échoué n'est pas orpheline.
    orphans = [v for v in all_uploads
               if v["id"] not in seen_ids and v["id"] not in in_playlists
               and v["id"] not in exclude_videos]

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

    if LOCAL_DIR is not None:
        # Battement de cœur : le run GitHub sait que PC1 tourne toujours.
        save_json(LOCAL_DIR / HEARTBEAT, {"at": datetime.now(timezone.utc).isoformat()})
        print(f"\n📤  {len(DEPOSITED)} vidéo(s) déposée(s) pour le run GitHub.")
    else:
        episodes.sort(key=lambda e: e.get("published_at", ""), reverse=True)
        save_json(EPISODES_FILE, episodes)
        print(f"\n✅  {added} nouvel(s) épisode(s) ajouté(s).")

    if PENDING:
        age = pc1_heartbeat_age_days()
        stale = age is None or age > HEARTBEAT_DAYS
        seen = "jamais vu" if age is None else f"vu il y a {age:.1f} j"
        print(f"\n⏸  {len(PENDING)} vidéo(s) bloquée(s) par YouTube, en attente du dépôt PC1 ({seen}).")
        if os.environ.get("GITHUB_ACTIONS"):
            level = "error" if stale else "warning"
            print(f"::{level} title=Podcasts en attente du PC1::{len(PENDING)} vidéo(s) en attente ; "
                  f"PC1 {seen}" + (" — vérifier la tâche planifiée « Sync podcasts ARCA »." if stale else "."))
        if stale:
            FAILURES.extend((v, "en attente du PC1, PC1 muet") for v in PENDING)

    # Un run qui n'importe rien parce que YouTube bloque doit être rouge, pas vert.
    if FAILURES:
        gated = sum(1 for _, r in FAILURES if r == "bot-gate")
        print(f"\n❌  {len(FAILURES)} vidéo(s) non importée(s), dont {gated} bloquée(s) par YouTube (bot-gate) :")
        for vid, reason in FAILURES:
            print(f"    - {vid} : {reason}")
        if os.environ.get("GITHUB_ACTIONS"):
            hint = "Vérifier la tâche planifiée PC1 (ou le secret YT_COOKIES)." if gated else "Voir le journal."
            print(f"::error title=Sync podcasts incomplète::{len(FAILURES)} vidéo(s) non importée(s), "
                  f"dont {gated} bloquée(s) par YouTube. {hint}")
        sys.exit(1)

if __name__ == "__main__":
    main()
