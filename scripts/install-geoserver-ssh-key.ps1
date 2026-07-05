# Installs this machine's own SSH *public* key onto a remote host's
# root authorized_keys. OS-agnostic on the remote side (only uses
# umask/mkdir/touch/cat/sort/chmod, present identically on Ubuntu and
# RHEL) — works unchanged against staging, pre-production, or production
# GeoServer hosts. Defaults to the "geoserver" SSH config alias (this
# session's dev/staging host) for backward compatibility; pass -TargetHost
# to point at pre-production/production instead once those are
# provisioned, rather than editing this file per environment.
param(
  [string]$TargetHost = "geoserver"
)

$ErrorActionPreference = "Stop"

$publicKeyPath = Join-Path $env:USERPROFILE ".ssh\id_ed25519.pub"
if (-not (Test-Path -LiteralPath $publicKeyPath)) {
  throw "Public key not found: $publicKeyPath"
}

Write-Host "Step 1/2: copying public key to $TargetHost. Enter the root password if prompted..."
scp $publicKeyPath "root@${TargetHost}:/tmp/urida_id_ed25519.pub"

Write-Host "Step 2/2: installing public key into /root/.ssh/authorized_keys. Enter the root password if prompted..."
$remoteCommand = "umask 077; mkdir -p /root/.ssh; touch /root/.ssh/authorized_keys; cat /tmp/urida_id_ed25519.pub >> /root/.ssh/authorized_keys; sort -u /root/.ssh/authorized_keys -o /root/.ssh/authorized_keys; chmod 700 /root/.ssh; chmod 600 /root/.ssh/authorized_keys; rm -f /tmp/urida_id_ed25519.pub; echo SSH_KEY_INSTALLED"
ssh "root@${TargetHost}" $remoteCommand

Write-Host ""
Write-Host "Now test: ssh root@${TargetHost}"
