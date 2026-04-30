#!/usr/bin/env python3
"""
get_dropbox_token.py
Génère le refresh token Dropbox nécessaire pour sync.py.
À lancer une seule fois sur ton PC.
"""
import urllib.request, urllib.parse, json, webbrowser

print("\n=== Génération du Refresh Token Dropbox ===\n")
app_key    = input("1. Colle ton App Key     : ").strip()
app_secret = input("2. Colle ton App Secret  : ").strip()

auth_url = (
    "https://www.dropbox.com/oauth2/authorize"
    f"?client_id={app_key}"
    "&response_type=code"
    "&token_access_type=offline"
)

print(f"\n3. Ouverture du navigateur pour autoriser l'app…")
webbrowser.open(auth_url)
print(f"   (si le navigateur ne s'ouvre pas, copie cette URL)\n   {auth_url}\n")

auth_code = input("4. Colle le code affiché par Dropbox : ").strip()

# Échange du code contre un refresh token
data = urllib.parse.urlencode({
    "code":         auth_code,
    "grant_type":   "authorization_code",
    "client_id":    app_key,
    "client_secret": app_secret,
}).encode()

req = urllib.request.Request(
    "https://api.dropboxapi.com/oauth2/token",
    data=data,
    method="POST",
)
with urllib.request.urlopen(req) as r:
    result = json.loads(r.read())

refresh_token = result.get("refresh_token", "")

if not refresh_token:
    print("\n❌ Erreur :", result)
else:
    print("\n✅ Succès ! Voici tes 3 secrets à ajouter dans GitHub :\n")
    print(f"  DROPBOX_APP_KEY       = {app_key}")
    print(f"  DROPBOX_APP_SECRET    = {app_secret}")
    print(f"  DROPBOX_REFRESH_TOKEN = {refresh_token}")
    print("\nGarde ces valeurs, le refresh token ne sera plus affiché.\n")
