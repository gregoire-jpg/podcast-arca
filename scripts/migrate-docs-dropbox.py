#!/usr/bin/env python3
"""
migrate-docs-dropbox.py
Déplace les fichiers sur Dropbox vers la nouvelle arborescence qui respecte
la structure du site arca-revue.com, sans re-télécharger les fichiers.

Ancienne structure :
  /Documentation ARCA/articles/Alchimie/fichier.pdf
  /Documentation ARCA/livres/Livres/fichier.pdf
  /Documentation ARCA/revue/Revue ARCA/fichier.pdf
  /Documentation ARCA/lus-pour-vous/Alchimie/fichier.pdf

Nouvelle structure :
  /Documentation ARCA/Articles/Alchimie/fichier.pdf
  /Documentation ARCA/Livres/fichier.pdf
  /Documentation ARCA/Revue ARCA/fichier.pdf
  /Documentation ARCA/Lus pour vous/Alchimie/fichier.pdf

Les liens partagés Dropbox survivent aux déplacements → pas besoin de
mettre à jour documents.json.

Usage :
  python scripts/migrate-docs-dropbox.py
"""

import os, sys, json, unicodedata, re
from pathlib import Path

try:
    import dropbox
    from dropbox.exceptions import ApiError
except ImportError:
    print("❌  pip install dropbox")
    sys.exit(1)

ROOT      = Path(__file__).parent.parent
DOCS_FILE = ROOT / "documents.json"

# ──────────────── Mapping ancien → nouveau dossier ────────────────

OLD_ROOTS = {
    "article":      "articles",
    "livre":        "livres/Livres",
    "revue":        "revue/Revue ARCA",
    "lus-pour-vous":"lus-pour-vous",
}

NEW_ROOTS = {
    "article":      "Articles",
    "livre":        "Livres",
    "revue":        "Revue ARCA",
    "lus-pour-vous":"Lus pour vous",
}

DROPBOX_BASE = "/Documentation ARCA"

# ──────────────── Utilitaires ────────────────

def slugify(text):
    text = unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode()
    text = re.sub(r"[^\w\s-]", "", text.lower())
    text = re.sub(r"[\s_-]+", "-", text).strip("-")
    return text[:80]

def old_path(doc):
    t    = doc.get("type", "")
    cat  = doc.get("category", "")
    fname = slugify(doc.get("title", doc.get("id", "inconnu"))) + ".pdf"
    root = OLD_ROOTS.get(t, t)
    if t in ("article", "lus-pour-vous"):
        return f"{DROPBOX_BASE}/{root}/{cat}/{fname}"
    else:
        return f"{DROPBOX_BASE}/{root}/{fname}"

def new_path(doc):
    t    = doc.get("type", "")
    cat  = doc.get("category", "")
    fname = slugify(doc.get("title", doc.get("id", "inconnu"))) + ".pdf"
    root = NEW_ROOTS.get(t, t)
    if t in ("article", "lus-pour-vous"):
        return f"{DROPBOX_BASE}/{root}/{cat}/{fname}"
    else:
        return f"{DROPBOX_BASE}/{root}/{fname}"

def make_dbx():
    return dropbox.Dropbox(
        oauth2_refresh_token=os.environ["DROPBOX_REFRESH_TOKEN"],
        app_key=os.environ["DROPBOX_APP_KEY"],
        app_secret=os.environ["DROPBOX_APP_SECRET"],
    )

# ──────────────── Main ────────────────

def main():
    docs = json.loads(DOCS_FILE.read_text(encoding="utf-8"))
    dbx  = make_dbx()

    to_move = [d for d in docs if d.get("dropbox_url")]
    print(f"📦 {len(to_move)} fichiers à déplacer sur Dropbox\n")

    moved = 0
    skipped = 0
    errors = 0

    for doc in to_move:
        src = old_path(doc)
        dst = new_path(doc)

        if src == dst:
            skipped += 1
            continue

        try:
            dbx.files_move_v2(src, dst, allow_shared_folder=True, autorename=False, allow_ownership_transfer=False)
            print(f"  ✅ {doc['title'][:55]}")
            print(f"     {src.split('/')[-1]} → {dst.rsplit('/',2)[-2]}/")
            moved += 1
        except ApiError as e:
            err_msg = str(e)
            if "not_found" in err_msg:
                # Fichier déjà au bon endroit ou introuvable
                print(f"  ⚠  Introuvable (déjà migré ?): {src.split('/')[-1]}")
                skipped += 1
            elif "to.conflict" in err_msg or "conflict" in err_msg:
                # Fichier existe déjà à destination
                print(f"  ⚠  Conflit (doublon ?): {dst.split('/')[-1]}")
                skipped += 1
            else:
                print(f"  ❌ {doc['title'][:40]} : {err_msg[:80]}")
                errors += 1

    print(f"\n✅ Migration terminée : {moved} déplacé(s), {skipped} ignoré(s), {errors} erreur(s)")
    print("Les liens Dropbox dans documents.json restent valides (non affectés par le déplacement).")

if __name__ == "__main__":
    main()
