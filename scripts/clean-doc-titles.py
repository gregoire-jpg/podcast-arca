#!/usr/bin/env python3
"""Nettoie les titres de documents.json : supprime le préfixe 'pdf' et le suffixe '.pdf'."""
import json, re
from pathlib import Path

f = Path(__file__).parent.parent / 'documents.json'
docs = json.loads(f.read_text(encoding='utf-8'))

def clean(title):
    t = (title or '').strip()
    # Supprimer le préfixe "pdf" (insensible à la casse)
    if t.lower().startswith('pdf'):
        t = t[3:].strip()
    # Supprimer le suffixe ".pdf"
    if t.lower().endswith('.pdf'):
        t = t[:-4].strip()
    return t

changed = 0
for doc in docs:
    original = doc.get('title', '')
    cleaned  = clean(original)
    if cleaned != original:
        doc['title'] = cleaned
        changed += 1

f.write_text(json.dumps(docs, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'✅ {changed} titre(s) nettoyé(s) sur {len(docs)} documents.')
