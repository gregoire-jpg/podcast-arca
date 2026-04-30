#!/usr/bin/env python3
"""
get_dropbox_token.py
Génère le refresh token Dropbox via le SDK officiel.
À lancer une seule fois sur ton PC.
"""
import webbrowser
import dropbox
from dropbox import DropboxOAuth2FlowNoRedirect

print("\n=== Génération du Refresh Token Dropbox ===\n")
app_key    = input("1. Colle ton App Key    : ").strip()
app_secret = input("2. Colle ton App Secret : ").strip()

auth_flow = DropboxOAuth2FlowNoRedirect(
    app_key,
    app_secret,
    token_access_type="offline"
)

authorize_url = auth_flow.start()
print(f"\n3. Ouverture du navigateur…")
webbrowser.open(authorize_url)
print(f"   (si le navigateur ne s'ouvre pas, copie cette URL)\n   {authorize_url}\n")

auth_code = input("4. Colle le code affiché par Dropbox : ").strip()

try:
    oauth_result = auth_flow.finish(auth_code)
except Exception as e:
    print(f"\n❌ Erreur : {e}")
    exit(1)

refresh_token = oauth_result.refresh_token

# Vérification immédiate
dbx = dropbox.Dropbox(
    oauth2_refresh_token=refresh_token,
    app_key=app_key,
    app_secret=app_secret
)
account = dbx.users_get_current_account()
print(f"\n✅ Connecté en tant que : {account.name.display_name}")
print(f"\nVoici tes 3 secrets à ajouter dans GitHub :\n")
print(f"  DROPBOX_APP_KEY       = {app_key}")
print(f"  DROPBOX_APP_SECRET    = {app_secret}")
print(f"  DROPBOX_REFRESH_TOKEN = {refresh_token}")
print("\nGarde ces valeurs précieusement.\n")
