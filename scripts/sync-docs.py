#!/usr/bin/env python3
"""
sync-docs.py — Télécharge toute la documentation de arca-revue.com
              et l'organise sur Dropbox.

Usage :
  python scripts/sync-docs.py              # télécharge tout
  python scripts/sync-docs.py --no-upload  # teste sans uploader sur Dropbox

⚠️  Si le site requiert une connexion, exporter les cookies depuis le
    navigateur (extension "Get cookies.txt LOCALLY") et les placer dans
    scripts/arca-cookies.txt

Dépendances :
  pip install requests beautifulsoup4 dropbox
"""

import os, sys, json, time, re, unicodedata
import urllib.request
from pathlib import Path

import requests
from bs4 import BeautifulSoup

try:
    import dropbox
    from dropbox.exceptions import ApiError
    from dropbox.files import WriteMode
except ImportError:
    print("❌  pip install dropbox")
    sys.exit(1)

# ──────────────────── Configuration ────────────────────

ROOT          = Path(__file__).parent.parent
DOCS_FILE     = ROOT / "documents.json"
DROPBOX_ROOT  = "/Documentation ARCA"
BASE_URL      = "https://arca-revue.com"
NO_UPLOAD     = "--no-upload" in sys.argv

# Cookies optionnels pour accéder aux contenus protégés
COOKIES_FILE  = Path(__file__).parent / "arca-cookies.txt"

# Catégories connues à crawler
CATEGORIES = {
    "articles": {
        "Alchimie":                        "/documentation/articles-1/alchimie/",
        "Hermétisme":                      "/documentation/articles-1/hermetisme/",
        "Christianisme":                   "/documentation/articles-1/christianisme/",
        "Classiques":                      "/documentation/articles-1/classiques/",
        "Louis Cattiaux & Message Retrouvé":"/documentation/articles-1/louis-cattiaux-et-le-message-retrouve/",
        "Judaïsme":                        "/documentation/articles-1/judaisme/",
        "Divers":                          "/documentation/articles-1/divers/",
        "Islam":                           "/documentation/articles-1/islam/",
        "Néerlandais":                     "/documentation/articles-1/artikels-in-het-nederlands/",
        "Néophytes":                       "/documentation/articles-1/neophoytes-debutants/",
    },
    "livres": {
        "Livres": "/documentation/livres/",
    },
    "revue": {
        "Revue ARCA": "/documentation/telechargements/",
    },
    "lus-pour-vous": {
        "Alchimie":    "/documentation/lus-pour-vous/alchimie/",
        "Christianisme":"/documentation/lus-pour-vous/christianisme/",
        "Classiques":  "/documentation/lus-pour-vous/classiques/",
        "Divers":      "/documentation/lus-pour-vous/divers/",
        "Égypte":      "/documentation/lus-pour-vous/egypte/",
        "Hermétisme":  "/documentation/lus-pour-vous/hermetisme/",
        "Islam":       "/documentation/lus-pour-vous/islam/",
        "Judaïsme":    "/documentation/lus-pour-vous/judaisme/",
    },
}

# ──────────────────── Utilitaires ────────────────────

def slugify(text):
    text = unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode()
    text = re.sub(r"[^\w\s-]", "", text.lower())
    text = re.sub(r"[\s_-]+", "-", text).strip("-")
    return text[:80]

def load_json(path, default):
    if path.exists():
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return default

def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def make_session():
    sess = requests.Session()
    sess.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    })
    # Charger les cookies si disponibles
    if COOKIES_FILE.exists():
        print(f"🍪 Chargement des cookies depuis {COOKIES_FILE.name}")
        with open(COOKIES_FILE, "r") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split("\t")
                if len(parts) >= 7:
                    sess.cookies.set(parts[5], parts[6], domain=parts[0])
    return sess

def make_dbx():
    return dropbox.Dropbox(
        oauth2_refresh_token=os.environ["DROPBOX_REFRESH_TOKEN"],
        app_key=os.environ["DROPBOX_APP_KEY"],
        app_secret=os.environ["DROPBOX_APP_SECRET"],
    )

# ──────────────────── Dropbox upload ────────────────────

CHUNK = 40 * 1024 * 1024  # 40 MB

def upload_to_dropbox(dbx, local_path, remote_path):
    size = os.path.getsize(local_path)
    with open(local_path, "rb") as f:
        if size <= CHUNK:
            dbx.files_upload(f.read(), remote_path, mode=WriteMode.overwrite)
        else:
            sess = dbx.files_upload_session_start(f.read(CHUNK))
            cursor = dropbox.files.UploadSessionCursor(session_id=sess.session_id, offset=f.tell())
            commit = dropbox.files.CommitInfo(path=remote_path, mode=WriteMode.overwrite)
            while f.tell() < size:
                remaining = size - f.tell()
                if remaining <= CHUNK:
                    dbx.files_upload_session_finish(f.read(CHUNK), cursor, commit)
                else:
                    dbx.files_upload_session_append_v2(f.read(CHUNK), cursor)
                    cursor.offset = f.tell()
    try:
        res = dbx.sharing_create_shared_link_with_settings(remote_path)
    except ApiError as e:
        if e.error.is_shared_link_already_exists():
            res = dbx.sharing_list_shared_links(path=remote_path).links[0]
        else:
            raise
    return res.url.replace("www.dropbox.com", "dl.dropboxusercontent.com").replace("?dl=0", "")

# ──────────────────── Crawling ────────────────────

def get_pdf_links(sess, url):
    """Extrait tous les liens PDF d'une page."""
    try:
        r = sess.get(url, timeout=30)
        r.raise_for_status()
    except Exception as e:
        print(f"  ⚠  Impossible d'accéder à {url} : {e}")
        return []

    soup = BeautifulSoup(r.text, "html.parser")
    links = []

    for a in soup.find_all("a", href=True):
        href = a["href"]
        text = a.get_text(strip=True)

        # Lien direct vers un PDF
        if href.lower().endswith(".pdf"):
            full = href if href.startswith("http") else BASE_URL + href
            links.append({"url": full, "title": text or Path(href).stem})

        # Lien vers une sous-page qui contient probablement un PDF
        elif href.startswith("/documentation/") and not href.endswith("/"):
            full = BASE_URL + href
            # Crawler la sous-page pour trouver le PDF
            try:
                sub = sess.get(full, timeout=20)
                sub_soup = BeautifulSoup(sub.text, "html.parser")
                for sub_a in sub_soup.find_all("a", href=True):
                    if sub_a["href"].lower().endswith(".pdf"):
                        pdf_url = sub_a["href"] if sub_a["href"].startswith("http") else BASE_URL + sub_a["href"]
                        links.append({"url": pdf_url, "title": text or sub_a.get_text(strip=True)})
                        break
            except Exception:
                pass

    return links

def download_file(sess, url, dest_path):
    """Télécharge un fichier depuis une URL."""
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        r = sess.get(url, stream=True, timeout=60)
        r.raise_for_status()
        with open(dest_path, "wb") as f:
            for chunk in r.iter_content(chunk_size=8192):
                f.write(chunk)
        return True
    except Exception as e:
        print(f"  ❌  Téléchargement échoué : {e}")
        return False

# ──────────────────── Main ────────────────────

def main():
    print("📚 Synchronisation de la documentation ARCA\n")

    sess = make_session()
    dbx  = make_dbx() if not NO_UPLOAD else None
    docs = load_json(DOCS_FILE, [])

    # Index des URLs déjà traitées
    seen_urls = {d.get("source_url", "") for d in docs}
    added = 0

    import tempfile

    for doc_type, categories in CATEGORIES.items():
        for cat_name, cat_path in categories.items():
            cat_url = BASE_URL + cat_path
            print(f"\n📁 {doc_type.upper()} / {cat_name}")
            print(f"   {cat_url}")

            links = get_pdf_links(sess, cat_url)
            print(f"   {len(links)} document(s) trouvé(s)")

            for link in links:
                url   = link["url"]
                title = link["title"]

                if url in seen_urls:
                    print(f"   ✓ {title[:50]}")
                    continue

                print(f"   ⬇  {title[:50]}")

                # Dossier Dropbox
                remote_dir  = f"{DROPBOX_ROOT}/{doc_type}/{cat_name}"
                filename    = slugify(title) + ".pdf"
                remote_path = f"{remote_dir}/{filename}"

                dropbox_url = ""

                with tempfile.TemporaryDirectory() as tmp:
                    local = Path(tmp) / filename
                    ok = download_file(sess, url, local)
                    if not ok:
                        continue

                    if not NO_UPLOAD and dbx:
                        print(f"   ☁  Upload Dropbox…")
                        try:
                            dropbox_url = upload_to_dropbox(dbx, str(local), remote_path)
                        except Exception as e:
                            print(f"   ⚠  Upload échoué : {e}")
                    else:
                        print(f"   [mode --no-upload, pas d'upload]")

                doc_entry = {
                    "id":           slugify(title),
                    "title":        title,
                    "type":         doc_type,
                    "category":     cat_name,
                    "authors":      [],
                    "author_display":"",
                    "subject":      slugify(cat_name),
                    "publication":  "",
                    "year":         "",
                    "dropbox_url":  dropbox_url,
                    "source_url":   url,
                }
                docs.append(doc_entry)
                seen_urls.add(url)
                save_json(DOCS_FILE, docs)
                added += 1
                time.sleep(0.5)

    print(f"\n✅  {added} document(s) ajouté(s). Total : {len(docs)}")
    save_json(DOCS_FILE, docs)

if __name__ == "__main__":
    main()
