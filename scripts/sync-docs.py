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
        "Néophytes":                       "/documentation/articles-1/neophytes/",
    },
    "livres": {
        "Livres":                              "/documentation/livres/",
        "Bibliographies et Dictionnaires":     "/documentation/livres/bibliographies/",
        "Cabale hébraïque — Dicos & Grammaires": "/documentation/livres/cabale-hebraique-dicos-grammaires/",
    },
    "revue": {
        # La page principale liste des sous-pages → crawl 2 niveaux
        "Revue ARCA":        "/documentation/telechargements/",
        # Suppléments (3 sous-dossiers, chacun avec 1 document)
        "Revue ARCA Suppléments — Contes":   "/documentation/telechargements/arca-revue-supplements/arca-volume-de-contes/",
        "Revue ARCA Suppléments — Jeux":     "/documentation/telechargements/arca-revue-supplements/arca-volume-de-jeux/",
        "Revue ARCA Suppléments — Prières":  "/documentation/telechargements/arca-revue-supplements/arca-volumes-de-prieres/",
    },
    "lus-pour-vous": {
        "Alchimie":     "/documentation/lus-pour-vous/alchimie-1/",
        "Christianisme":"/documentation/lus-pour-vous/christianisme-1/",
        "Classiques":   "/documentation/lus-pour-vous/classiques-1/",
        "Divers":       "/documentation/lus-pour-vous/divers-1/",
        "Égypte":       "/documentation/lus-pour-vous/egypte/",
        "Hermétisme":   "/documentation/lus-pour-vous/hermetisme-1/",
        "Islam":        "/documentation/lus-pour-vous/islam-1/",
        "Judaïsme":     "/documentation/lus-pour-vous/judaisme-1/",
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

def _extract_file_links(soup, seen):
    """Extrait les liens ?layout=file ou .pdf d'un objet BeautifulSoup."""
    links = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        text = a.get_text(strip=True)

        if "?layout=file" in href:
            full = href if href.startswith("http") else BASE_URL + href
            if full not in seen:
                seen.add(full)
                slug  = href.split("?")[0].rstrip("/").split("/")[-1]
                raw   = text or slug.replace("-", " ").title()
                # Nettoyer le préfixe "pdf" et le suffixe ".pdf"
                t = raw.strip()
                if t.lower().startswith("pdf"):
                    t = t[3:].strip()
                if t.lower().endswith(".pdf"):
                    t = t[:-4].strip()
                links.append({"url": full, "title": t or raw})

        elif href.lower().endswith(".pdf"):
            full = href if href.startswith("http") else BASE_URL + href
            if full not in seen:
                seen.add(full)
                links.append({"url": full, "title": text or Path(href).stem})

    return links


def _get_doc_subpages(soup, base_url):
    """Retourne les URLs des sous-pages de documentation (1 niveau)."""
    subpages = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        full = href if href.startswith("http") else BASE_URL + href
        # Sous-page de documentation non terminée par un mot-clé de nav
        if (
            "/documentation/" in full
            and full.rstrip("/") != base_url.rstrip("/")
            and "?layout=file" not in full
            and not any(k in full for k in ["/connexion", "/sinscrire", "/oublie", "/lp-profile"])
        ):
            subpages.append(full)
    return list(dict.fromkeys(subpages))  # dédoublonner en conservant l'ordre


def _get_pagination_urls(soup, base_url):
    """Retourne les URLs de pagination (?limit=20&offset=X)."""
    pages = []
    base = base_url.split("?")[0].rstrip("/")
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if "offset=" in href and "limit=" in href:
            full = href if href.startswith("http") else BASE_URL + href
            if full not in pages:
                pages.append(full)
    return pages


def get_pdf_links(sess, url):
    """Extrait tous les liens de documents d'une page ARCA.

    - Gère la pagination (?limit=20&offset=X)
    - Crawle les sous-pages si aucun fichier direct (ex: Revue ARCA)
    """
    try:
        r = sess.get(url, timeout=30)
        r.raise_for_status()
    except Exception as e:
        print(f"  ⚠  Impossible d'accéder à {url} : {e}")
        return []

    soup  = BeautifulSoup(r.text, "html.parser")
    seen  = set()
    links = _extract_file_links(soup, seen)

    # Pagination : récupérer toutes les pages suivantes
    page_urls = _get_pagination_urls(soup, url)
    if page_urls:
        print(f"  → {len(page_urls)} page(s) supplémentaire(s) détectée(s)…")
    for page_url in page_urls:
        try:
            pr   = sess.get(page_url, timeout=30)
            pr.raise_for_status()
            psoup = BeautifulSoup(pr.text, "html.parser")
            pl    = _extract_file_links(psoup, seen)
            links.extend(pl)
            time.sleep(0.3)
        except Exception as e:
            print(f"    ⚠  {page_url} : {e}")

    # Aucun fichier trouvé → crawler les sous-pages (ex: Revue ARCA par numéro)
    if not links:
        subpages = _get_doc_subpages(soup, url)
        if subpages:
            print(f"  → {len(subpages)} sous-page(s) à explorer…")
        for sub_url in subpages:
            try:
                sub_r    = sess.get(sub_url, timeout=30)
                sub_r.raise_for_status()
                sub_soup = BeautifulSoup(sub_r.text, "html.parser")
                sub_links = _extract_file_links(sub_soup, seen)
                links.extend(sub_links)
                if sub_links:
                    print(f"    ✓ {sub_url.split('/')[-2]} → {len(sub_links)} fichier(s)")
                time.sleep(0.3)
            except Exception as e:
                print(f"    ⚠  {sub_url} : {e}")

    return links

def download_file(sess, url, dest_path):
    """Télécharge un fichier depuis une URL (suit les redirections)."""
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        r = sess.get(url, stream=True, timeout=120, allow_redirects=True)
        r.raise_for_status()

        # Vérifier que c'est bien un fichier (PDF ou autre binaire)
        ct = r.headers.get("Content-Type", "")
        if "text/html" in ct and "application/pdf" not in ct:
            # Page HTML — le fichier n'est peut-être pas directement accessible
            print(f"  ⚠  Reçu HTML au lieu d'un fichier (Content-Type: {ct[:50]})")
            return False

        # Adapter l'extension selon le Content-Type
        if "application/pdf" in ct and not str(dest_path).endswith(".pdf"):
            dest_path = dest_path.with_suffix(".pdf")

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

    # Index des URLs déjà uploadées sur Dropbox (ignore les échecs précédents)
    seen_urls = {d.get("source_url", "") for d in docs if d.get("dropbox_url")}
    # Supprimer les entrées sans dropbox_url pour les réessayer
    docs = [d for d in docs if d.get("dropbox_url")]
    print(f"📋 {len(docs)} document(s) déjà sur Dropbox, réessai des autres…")
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

                # Dossier Dropbox — arborescence miroir du site ARCA
                filename = slugify(title) + ".pdf"
                if doc_type == "article":
                    remote_path = f"{DROPBOX_ROOT}/Articles/{cat_name}/{filename}"
                elif doc_type == "livre":
                    remote_path = f"{DROPBOX_ROOT}/Livres/{filename}"
                elif doc_type == "revue":
                    remote_path = f"{DROPBOX_ROOT}/Revue ARCA/{filename}"
                else:  # lus-pour-vous
                    remote_path = f"{DROPBOX_ROOT}/Lus pour vous/{cat_name}/{filename}"

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
