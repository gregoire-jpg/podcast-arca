#!/usr/bin/env python3
"""
sync_rivista.py — YouTube @arcarivista → MP3 sur Infomaniak → arca_podcast (MySQL).

Pour le site italien arcarivista.it (dépôt privé arca-rivista), lancé par
.github/workflows/sync-rivista.yml. Équivalent de scripts/sync.py (FR), mais
l'audio va sur l'hébergement (~/sites/arcarivista.it/audio/) et non sur Dropbox,
et l'état « déjà fait » est lu sur le serveur (rien n'est commité ici).
L'enregistrement en base est fait sur le serveur par
api/cli/podcast-ingest.php (code dans arca-rivista).

  python3 scripts/sync_rivista.py plan [--all]   → écrit les ids à traiter (un par ligne)
  python3 scripts/sync_rivista.py run ID [ID…]   → télécharge, encode, envoie, enregistre
  python3 scripts/sync_rivista.py ingest         → relance seulement l'enregistrement en base
  python3 scripts/sync_rivista.py local ID [--out DIR]  → test local : MP3 + .json, sans serveur

`plan` n'a besoin ni de yt-dlp ni de ffmpeg (flux RSS + `ls` SSH) : le
workflow peut donc s'arrêter sans rien installer quand il n'y a rien de neuf.

Variables d'environnement :
  CHANNEL_ID        défaut UCTm9Iopq6Rpch_AkJtvEZrw
  SSH_HOST, SSH_USER, SSH_KEY (chemin de la clé privée, défaut ~/.ssh/deploy_key)
  REMOTE_DOCROOT    défaut sites/arcarivista.it (relatif au home SSH)
  MIN_DURATION      défaut 181 s : en dessous (Shorts) → marqueur .skip, pas d'épisode
  MAX_PER_RUN       défaut 8 : borne les minutes Actions d'un passage
  AUDIO_BITRATE     défaut 64k (mono : parole)
  YT_COOKIES_FILE   cookies.txt Netscape (anti bot-gate), optionnel
  YT_JS_RUNTIME     défaut node (yt-dlp ≥ 2025.11 exige un moteur JS pour YouTube)
"""

import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

CHANNEL_ID     = os.environ.get("CHANNEL_ID", "UCTm9Iopq6Rpch_AkJtvEZrw")
SSH_HOST       = os.environ.get("SSH_HOST", "")
SSH_USER       = os.environ.get("SSH_USER", "")
SSH_KEY        = os.path.expanduser(os.environ.get("SSH_KEY", "~/.ssh/deploy_key"))
REMOTE_DOCROOT = os.environ.get("REMOTE_DOCROOT", "sites/arcarivista.it").rstrip("/")
REMOTE_AUDIO   = f"{REMOTE_DOCROOT}/audio"
MIN_DURATION   = int(os.environ.get("MIN_DURATION", "181"))
MAX_PER_RUN    = int(os.environ.get("MAX_PER_RUN", "8"))
AUDIO_BITRATE  = os.environ.get("AUDIO_BITRATE", "64k")
JS_RUNTIME     = os.environ.get("YT_JS_RUNTIME", "node")

VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}")

SSH_OPTS = ["-4", "-i", SSH_KEY, "-p", "22", "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=20"]


def log(msg):
    print(msg, file=sys.stderr, flush=True)


# ─────────────────────────── Serveur (SSH) ───────────────────────────

def ssh(cmd, check=True):
    if not (SSH_HOST and SSH_USER):
        raise SystemExit("SSH_HOST / SSH_USER manquants")
    res = subprocess.run(["ssh", *SSH_OPTS, f"{SSH_USER}@{SSH_HOST}", cmd],
                         capture_output=True, text=True, timeout=300)
    if check and res.returncode != 0:
        raise SystemExit(f"SSH échoué ({res.returncode}) : {res.stderr.strip()[:400]}")
    return res.stdout


def remote_done_ids():
    """Ids déjà traités sur le serveur : ID.mp3 (épisode) ou ID.skip (Short écarté)."""
    out = ssh(f"ls -1 {shlex.quote(REMOTE_AUDIO)} 2>/dev/null || true")
    done = set()
    for name in out.split():
        stem, _, ext = name.rpartition(".")
        if ext in ("mp3", "skip") and stem:
            done.add(stem)
    return done


def upload(paths):
    """rsync des fichiers vers ~/<docroot>/audio/ (dossier créé au besoin)."""
    if not paths:
        return
    ssh_cmd = "ssh " + " ".join(shlex.quote(o) for o in SSH_OPTS)
    subprocess.run(
        ["rsync", "-t", "--chmod=F644,D755",
         "--rsync-path", f"mkdir -p {shlex.quote(REMOTE_AUDIO)} && rsync",
         "-e", ssh_cmd, *[str(p) for p in paths],
         f"{SSH_USER}@{SSH_HOST}:{REMOTE_AUDIO}/"],
        check=True, timeout=1800)


def remote_ingest():
    """Enregistre en base (arca_podcast) tout MP3 + .json présent dans audio/."""
    out = ssh(f"php {shlex.quote(REMOTE_DOCROOT + '/api/cli/podcast-ingest.php')}")
    log(out.strip())


# ─────────────────────────── YouTube ─────────────────────────────────

def rss_ids():
    """15 dernières vidéos de la chaîne (flux public, sans clé ni yt-dlp)."""
    url = f"https://www.youtube.com/feeds/videos.xml?channel_id={CHANNEL_ID}"
    ns = {"yt": "http://www.youtube.com/xml/schemas/2015",
          "atom": "http://www.w3.org/2005/Atom"}
    last_exc = None
    for attempt in range(3):  # le flux YouTube renvoie parfois un 404/500 passager
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                root = ET.fromstring(r.read())
            return [e.find("yt:videoId", ns).text for e in root.findall("atom:entry", ns)]
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            time.sleep(5 * (attempt + 1))
    raise SystemExit(f"Flux RSS YouTube inaccessible : {last_exc}")


def ytdlp_base():
    args = [sys.executable, "-m", "yt_dlp", "--no-warnings", "--no-progress"]
    if JS_RUNTIME:
        args += ["--js-runtimes", JS_RUNTIME]
    cookies = os.environ.get("YT_COOKIES_FILE", "").strip()
    if cookies and os.path.isfile(cookies):
        args += ["--cookies", cookies]
    return args


def all_upload_ids():
    """Toutes les vidéos de la chaîne (playlist auto « uploads » UC→UU) — rattrapage."""
    res = subprocess.run(
        [*ytdlp_base(), "--flat-playlist", "--print", "%(id)s",
         f"https://www.youtube.com/playlist?list=UU{CHANNEL_ID[2:]}"],
        capture_output=True, text=True, timeout=300)
    if res.returncode != 0:
        raise SystemExit(f"yt-dlp (liste) : {res.stderr.strip()[:400]}")
    return [l.strip() for l in res.stdout.splitlines() if l.strip()]


def fetch_meta(video_id):
    res = subprocess.run(
        [*ytdlp_base(), "-J", "--skip-download", f"https://www.youtube.com/watch?v={video_id}"],
        capture_output=True, text=True, timeout=300)
    if res.returncode != 0:
        return None, res.stderr.strip()
    return json.loads(res.stdout), ""


def build_mp3(video_id, meta, workdir):
    """Télécharge la meilleure piste audio puis encode en MP3 mono (parole)."""
    raw_tpl = os.path.join(workdir, f"{video_id}.src.%(ext)s")
    res = subprocess.run(
        [*ytdlp_base(), "-f", "bestaudio/best", "-o", raw_tpl,
         f"https://www.youtube.com/watch?v={video_id}"],
        capture_output=True, text=True, timeout=3600)
    if res.returncode != 0:
        raise RuntimeError(f"yt-dlp : {res.stderr.strip()[:400]}")
    src = next(Path(workdir).glob(f"{video_id}.src.*"), None)
    if src is None:
        raise RuntimeError("fichier source introuvable après yt-dlp")

    mp3 = Path(workdir) / f"{video_id}.mp3"
    date = (meta.get("upload_date") or "")[:4]
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
           "-vn", "-map_metadata", "-1", "-ac", "1", "-ar", "44100", "-b:a", AUDIO_BITRATE,
           "-id3v2_version", "3",
           "-metadata", f"title={meta.get('title') or video_id}",
           "-metadata", "artist=Arca Rivista",
           "-metadata", "album=Arca Rivista — Podcast",
           "-metadata", "genre=Podcast"]
    if date:
        cmd += ["-metadata", f"date={date}"]
    cmd.append(str(mp3))
    subprocess.run(cmd, check=True, timeout=3600)
    src.unlink(missing_ok=True)
    return mp3


def stable_thumb(video_id, meta):
    """Miniature à URL stable (sans paramètres signés qui expirent)."""
    urls = {t.get("url", "") for t in meta.get("thumbnails") or []}
    for name in ("maxresdefault.jpg", "sddefault.jpg"):
        u = f"https://i.ytimg.com/vi/{video_id}/{name}"
        if u in urls:
            return u
    return f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"


def sidecar(video_id, meta, mp3):
    """Métadonnées lues par api/cli/podcast-ingest.php (titre, description, miniature…)."""
    data = {
        "id":          video_id,
        "title":       meta.get("title") or "",
        "description": meta.get("description") or "",
        "upload_date": meta.get("upload_date") or "",
        "timestamp":   meta.get("timestamp") or meta.get("release_timestamp"),
        "duration":    int(meta.get("duration") or 0),
        "thumbnail":   stable_thumb(video_id, meta),
        "webpage_url": meta.get("webpage_url") or f"https://www.youtube.com/watch?v={video_id}",
        "file":        mp3.name,
        "bytes":       mp3.stat().st_size,
    }
    path = mp3.with_suffix(".json")
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    return path


def process(video_id, workdir):
    """Renvoie la liste des fichiers à envoyer, [] si la vidéo est à retenter plus tard.
    Lève RuntimeError en cas d'échec réel (bot-gate, réseau…)."""
    meta, err = fetch_meta(video_id)
    if meta is None:
        raise RuntimeError(f"métadonnées : {err[:400]}")
    live = meta.get("live_status") or ""
    if live in ("is_upcoming", "is_live", "post_live"):
        log(f"  … {video_id} : direct en cours ou à venir ({live}) — retenté au prochain passage")
        return []
    duration = int(meta.get("duration") or 0)
    if duration and duration < MIN_DURATION:
        log(f"  ⏭ {video_id} : {duration} s < {MIN_DURATION} s (Short) — écarté")
        marker = Path(workdir) / f"{video_id}.skip"
        marker.write_text(f"{meta.get('title') or ''}\n", encoding="utf-8")
        return [marker]
    log(f"  ⬇ {video_id} : {meta.get('title','')[:70]} ({duration} s)")
    mp3 = build_mp3(video_id, meta, workdir)
    js = sidecar(video_id, meta, mp3)
    log(f"  ✓ {mp3.name} ({mp3.stat().st_size // 1024} Ko)")
    return [mp3, js]


# ─────────────────────────── Commandes ───────────────────────────────

def cmd_plan(argv):
    ids = all_upload_ids() if "--all" in argv else rss_ids()
    if not ids:
        log("Aucune vidéo sur la chaîne.")
        return 0
    ids = [i for i in ids if VIDEO_ID.fullmatch(i or "")]
    done = remote_done_ids()
    todo = [i for i in ids if i not in done]
    todo.reverse()                      # flux = plus récent d'abord → on traite le plus ancien d'abord
    if len(todo) > MAX_PER_RUN:
        log(f"{len(todo)} vidéo(s) nouvelles, {MAX_PER_RUN} traitées ce passage (le reste au suivant).")
        todo = todo[:MAX_PER_RUN]
    log(f"{len(ids)} vidéo(s) listée(s), {len(done)} déjà sur le serveur, {len(todo)} à traiter.")
    print("\n".join(todo))
    return 0


def cmd_run(ids):
    failures = 0
    sent = 0
    with tempfile.TemporaryDirectory() as tmp:
        for vid in ids:
            try:
                files = process(vid, tmp)
                if files:
                    upload(files)       # envoi immédiat : un échec plus loin ne perd pas celui-ci
                    sent += 1
                    for f in files:
                        Path(f).unlink(missing_ok=True)
            except Exception as exc:    # noqa: BLE001
                failures += 1
                log(f"  ✗ {vid} : {exc}")
    if sent:
        remote_ingest()
    log(f"{sent} envoyé(s), {failures} échec(s).")
    return 1 if failures else 0


def cmd_local(argv):
    out, ids, it = Path("podcast-out"), [], iter(argv)
    for a in it:
        if a == "--out":
            out = Path(next(it))
        else:
            ids.append(a)
    out.mkdir(parents=True, exist_ok=True)
    for vid in ids:
        for f in process(vid, str(out)):
            log(f"  → {f}")
    return 0


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    cmd, argv = sys.argv[1], sys.argv[2:]
    if cmd == "plan":
        return cmd_plan(argv)
    if cmd == "run":
        return cmd_run([a for a in argv if VIDEO_ID.fullmatch(a)])
    if cmd == "ingest":
        remote_ingest()
        return 0
    if cmd == "local":
        return cmd_local(argv)
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
