# sync-pc1.ps1 — dépôt des MP3 podcasts ARCA depuis PC1 (IP résidentielle).
#
# YouTube bloque les téléchargements depuis GitHub Actions. Ce script, lancé par
# la tâche planifiée Windows « Sync podcasts ARCA », télécharge l'audio des
# nouvelles vidéos et le dépose dans le dossier Dropbox de l'app (synchronisé) ;
# le workflow sync.yml publie ensuite les épisodes.
#
# Installer / réinstaller la tâche :  scripts\sync-pc1.ps1 -Install
# Journal : %LOCALAPPDATA%\podcast-arca\sync-pc1.log (dernier passage)

param([switch]$Install)

$repo = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $env:LOCALAPPDATA "podcast-arca"
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir "sync-pc1.log"

if ($Install) {
    # Windows PowerShell (chemin fixe) : pwsh du Microsoft Store change de chemin à chaque
    # mise à jour et le planificateur ne le trouve pas par son nom (0x80070002).
    $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`""
    # Avant chaque passage GitHub (00, 06, 12, 18 h UTC = 2, 8, 14, 20 h en été) : le dépôt a
    # le temps d'être synchronisé par Dropbox.
    $triggers = @("06:00", "12:00", "18:00", "23:00") | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ }
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries `
        -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName "Sync podcasts ARCA" -Action $action -Trigger $triggers `
        -Settings $settings -Description "YouTube -> MP3 -> Dropbox (podcast-arca, scripts/sync-pc1.ps1)" -Force | Out-Null
    Write-Output "Tâche « Sync podcasts ARCA » installée."
    return
}

# Code de sortie de la tâche : 0 seulement si tout a réussi. Sans cela le planificateur
# affichait 0 (« réussi ») même quand sync.py plantait, et l'échec ne se voyait nulle part.
$rc = 0
Start-Transcript -Path $log -Force | Out-Null
try {
    Set-Location $repo
    $env:PYTHONIOENCODING = "utf-8"
    # episodes.json à jour : sinon on retéléchargerait ce que GitHub a déjà publié.
    # Via cmd : Windows PowerShell 5.1 transforme toute ligne écrite sur stderr
    # (avis pip, messages git) en fausse « NativeCommandError » dans le journal.
    cmd /c "git pull --ff-only --quiet 2>&1"
    if ($LASTEXITCODE -ne 0) { Write-Output "git pull en echec ($LASTEXITCODE)"; $rc = 2 }
    cmd /c "python -m pip install --quiet --disable-pip-version-check --upgrade yt-dlp[default] dropbox 2>&1"
    cmd /c "python scripts/sync.py --pc1 2>&1"
    Write-Output "Code de sortie : $LASTEXITCODE"
    if ($LASTEXITCODE -ne 0) { $rc = 1 }

    # Site italien arcarivista.it : même blocage YouTube depuis GitHub, donc ici aussi.
    # sync_rivista.py envoie lui-même le MP3 sur l'hébergement et l'enregistre en base
    # (clé SSH dédiée ~/.ssh/arcarivista_podcast_sync, déjà autorisée sur le serveur).
    $env:SSH_HOST = "b61u9a.ftp.infomaniak.com"
    $env:SSH_USER = "b61u9a_gregoire"
    $env:SSH_KEY  = Join-Path $HOME ".ssh\arcarivista_podcast_sync"
    $ids = @(cmd /c "python scripts/sync_rivista.py plan 2>nul") | Where-Object { $_ -match '^[A-Za-z0-9_-]{11}$' }
    if ($ids) {
        Write-Output "Rivista : $($ids.Count) vidéo(s) à traiter"
        cmd /c "python scripts/sync_rivista.py run $($ids -join ' ') 2>&1"
        Write-Output "Rivista, code de sortie : $LASTEXITCODE"
        if ($LASTEXITCODE -ne 0) { $rc = 3 }
    } else { Write-Output "Rivista : rien de neuf." }
} catch {
    Write-Output "Erreur : $_"
    $rc = 4
} finally {
    Write-Output "Resultat de la tache : $rc"
    Stop-Transcript | Out-Null
}
exit $rc
