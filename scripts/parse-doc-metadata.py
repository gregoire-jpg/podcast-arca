#!/usr/bin/env python3
"""
parse-doc-metadata.py
Analyse les titres de documents.json et extrait automatiquement :
  - author_display  (auteur)
  - title           (titre propre)
  - publication     (source : ARCA 1, Via Hermetica, Fil d'Ariane…)

Ne modifie QUE les champs vides — ne risque pas d'écraser un travail manuel.

Patterns reconnus dans les titres :
  "Nom, Prénom - Titre de l'article - ARCA 3"
  "d'Hooghvorst, E. - Texte - Fil d'Ariane 2"
  "Auteur A et Auteur B - Titre"
  "Berthelot, M , Collection des anciens…"  (format lus-pour-vous)
  "1- Lettre au néophyte"                   (liste numérotée)
"""

import json, re, unicodedata
from pathlib import Path

ROOT      = Path(__file__).parent.parent
DOCS_FILE = ROOT / "documents.json"

# ── Publications connues ──────────────────────────────────────────────────────
PUB_RE = re.compile(
    r"^("
    r"ARCA\s*\d*\s*(?:N\.?S\.?|\(NS\))?"   # ARCA 1, ARCA 6 (NS), ARCA 6 NS
    r"|Via\s+Hermetica\s*\d*"              # Via Hermetica, Via Hermetica 3
    r"|Fil\s+d.Ariane\s*[\d\-]+"          # Fil d'Ariane 2, Fil d'Ariane 57-58
    r"|Miroir\s+d.Isis\s*\d+"             # Miroir d'Isis 16
    r"|La\s+Puerta\s*\d*"                 # La Puerta 73
    r"|Beya\s*\d*"                        # Beya, Beya 10
    r"|Epignosis"
    r"|Revue\s+eccl"
    r"|Colloque\s+Canseliet"
    r"|FNAC"
    r"|YouTube"
    r"|\d{4}"                             # Année seule : 1860, 2024
    r")$",
    re.IGNORECASE,
)

# ── Débuts caractéristiques de TITRES (pas d'auteurs) ────────────────────────
TITLE_STARTERS = re.compile(
    r"^(Le\s|La\s|Les\s|Un\s|Une\s|Du\s|De\s|Des\s|Au\s|Aux\s|En\s|Sur\s|Dans\s"
    r"|D'|L'|À\s|Quelques\s|Introduction|Présent|Confér|Notes?|Bref\s|Petit"
    r"|Grand|Lettre|Corresp|Extraits?|Comment|Pourquoi|Quand|Bois\s|Dessins"
    r"|Gloria|Essai|Réflexions|Aperçus?|Vrai|Saint|À\spropos|Aux\sportes"
    r"|Brief|Waarom|Commentaire|Hommage|La\scorne|Moïse|Acte\s|Thème)",
    re.IGNORECASE,
)

def slugify(text):
    s = unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:60]

def is_publication(s):
    return bool(PUB_RE.match(s.strip()))

def is_author_segment(s):
    """Heuristique : ce segment ressemble-t-il à un auteur ?"""
    s = s.strip()
    if len(s) > 55:
        return False
    if TITLE_STARTERS.match(s):
        return False
    # Format "Nom, Prénom" ou "Nom, P." → auteur certain
    if "," in s:
        # Vérifier que la partie avant la virgule est un nom (pas trop long)
        before_comma = s.split(",")[0].strip()
        if len(before_comma) < 25:
            return True
    # Pas de virgule mais court et capitalisé → possible auteur
    if len(s) < 20 and s[0].isupper() and " " not in s:
        return True
    return False

def clean(s):
    """Supprimer préfixe pdf et suffixe .pdf."""
    s = s.strip()
    if s.lower().startswith("pdf"):
        s = s[3:].strip()
    if s.lower().endswith(".pdf"):
        s = s[:-4].strip()
    return s

def parse_title(full_title, doc_type):
    """
    Retourne (author, title, publication).
    Gère les cas particuliers par type de document.
    """
    t = clean(full_title)

    # Supprimer les préfixes numériques "1- ", "2 - ", "9 - "
    t = re.sub(r"^\d+\s*[-–]\s*", "", t).strip()

    # Séparer par " - " (tiret entouré d'espaces)
    parts = [p.strip() for p in re.split(r"\s+-\s+", t) if p.strip()]

    if not parts:
        return "", t, ""

    pub    = ""
    author = ""
    title  = ""

    # ── 1. Détecter la publication (dernier segment) ──
    if len(parts) >= 2 and is_publication(parts[-1]):
        pub   = parts[-1]
        parts = parts[:-1]

    # ── 2. Détecter l'auteur (premier segment) ──
    if len(parts) >= 2 and is_author_segment(parts[0]):
        author = parts[0]
        title  = " - ".join(parts[1:])
    else:
        title = " - ".join(parts)

    # ── 3. Cas spécial : "Lus pour vous" → format "Nom, Prénom , Titre" ──
    if doc_type in ("lus-pour-vous", "livres") and not author and "," in title:
        m = re.match(r"^([^,]{2,30})\s*,\s+(.{5,})$", title)
        if m and not TITLE_STARTERS.match(m.group(1)):
            candidate_author = m.group(1).strip()
            candidate_title  = m.group(2).strip()
            # Vérifier que le "titre" restant est plausible
            if len(candidate_title) > 5:
                author = candidate_author
                title  = candidate_title

    # ── 4. Nettoyer l'auteur : supprimer "(intro)" ou "(preface)" ──
    author = re.sub(r"\s*\(intro\)\s*", "", author, flags=re.IGNORECASE).strip()
    author = re.sub(r"\s*\(preface\)\s*", "", author, flags=re.IGNORECASE).strip()

    return author, title or t, pub


def main():
    docs = json.loads(DOCS_FILE.read_text(encoding="utf-8"))
    updated = 0

    for doc in docs:
        orig = doc.get("title", "")
        doc_type = doc.get("type", "")

        author, title, pub = parse_title(orig, doc_type)

        changed = False

        # Mettre à jour le titre nettoyé
        if title and title != orig:
            doc["title"] = title
            changed = True

        # Remplir l'auteur si vide
        if author and not doc.get("author_display"):
            doc["author_display"] = author
            changed = True

        # Générer la clé auteur si vide
        if author and not doc.get("authors"):
            doc["authors"] = [slugify(author)]
            changed = True

        # Remplir la publication si vide
        if pub and not doc.get("publication"):
            doc["publication"] = pub
            changed = True

        if changed:
            updated += 1

    DOCS_FILE.write_text(
        json.dumps(docs, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"✅  {updated} document(s) enrichi(s) sur {len(docs)}.")


if __name__ == "__main__":
    main()
