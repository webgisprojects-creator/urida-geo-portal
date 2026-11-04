#!/usr/bin/env bash
# Production deploy script.
#
# Run from your laptop while connected to VPN:
#   bash scripts/deploy-prod.sh
#
# What it does:
#   1. Reads the commit that GitHub Actions just deployed to pre-prod
#   2. Copies server/src and client/build from pre-prod → local temp → prod
#   3. Restarts PM2 on prod and writes a VERSION file
#
# Requirements: SSH aliases "pre-production" in ~/.ssh/config, VPN active.

set -euo pipefail

PREPROD="pre-production"
PROD="root@192.168.190.112"
PREPROD_APP="/srv/urida/current"
PROD_APP="/srv/urida/current"
TMPDIR_BASE="${TMPDIR:-/tmp}/urida-deploy"

# ── 1. Read the commit deployed on pre-prod ───────────────────────────────────
echo ""
echo "==> Checking pre-production..."
COMMIT=$(ssh "$PREPROD" "sudo -u uridaapp git -C $PREPROD_APP rev-parse HEAD")
SHORT="${COMMIT:0:7}"
DATE=$(ssh "$PREPROD" "sudo -u uridaapp git -C $PREPROD_APP log -1 --format='%s (%ad)' --date=short HEAD")
PREPROD_HEALTH=$(ssh "$PREPROD" "curl -sf http://127.0.0.1:8060/api/health > /dev/null && echo OK || echo FAIL")

echo "  Commit : $SHORT"
echo "  Message: $DATE"
echo "  Health : $PREPROD_HEALTH"

if [ "$PREPROD_HEALTH" != "OK" ]; then
  echo ""
  echo "ERROR: Pre-production health check failed. Fix it before deploying to prod."
  exit 1
fi

# ── 2. Confirm ────────────────────────────────────────────────────────────────
echo ""
echo "  Target : PRODUCTION — uridageomap.upsdc.gov.in (192.168.190.112)"
echo ""
echo "  This will overwrite server/src and client/build on production."
echo "  node_modules and .env are NOT touched."
echo ""
read -rp "  Type DEPLOY to confirm: " CONFIRM
if [ "$CONFIRM" != "DEPLOY" ]; then
  echo "Cancelled."
  exit 0
fi

# ── 3. Fetch built code from pre-prod to local temp ───────────────────────────
TMPDIR="$TMPDIR_BASE/$SHORT"
rm -rf "$TMPDIR"
mkdir -p "$TMPDIR/server" "$TMPDIR/client"

echo ""
echo "==> Fetching server/src from pre-prod..."
rsync -az --delete \
  --exclude='*.bak*' \
  "$PREPROD:$PREPROD_APP/server/src/" \
  "$TMPDIR/server/src/"

echo "==> Fetching client/build from pre-prod..."
rsync -az --delete \
  "$PREPROD:$PREPROD_APP/client/build/" \
  "$TMPDIR/client/build/"

# ── 4. Push to production ─────────────────────────────────────────────────────
echo ""
echo "==> Pushing server/src to production..."
rsync -az --delete \
  --exclude='*.bak*' \
  "$TMPDIR/server/src/" \
  "$PROD:$PROD_APP/server/src/"

echo "==> Pushing client/build to production..."
rsync -az --delete \
  "$TMPDIR/client/build/" \
  "$PROD:$PROD_APP/client/build/"

# ── 5. Write VERSION file ─────────────────────────────────────────────────────
echo ""
echo "==> Writing VERSION file on production..."
ssh "$PROD" "cat > $PROD_APP/VERSION << 'EOF'
COMMIT=$COMMIT
SHORT=$SHORT
MESSAGE=$DATE
DEPLOYED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DEPLOYED_BY=${USER:-unknown}
EOF"

# ── 6. Fix ownership (files land as root via SSH, app runs as uridaapp) ───────
echo "==> Fixing file ownership on production..."
ssh "$PROD" "chown -R uridaapp:uridaapp $PROD_APP/server/src $PROD_APP/client/build $PROD_APP/VERSION"

# ── 7. Restart PM2 ───────────────────────────────────────────────────────────
echo "==> Restarting PM2 on production..."
ssh "$PROD" "sudo -Hu uridaapp bash -lc 'pm2 restart urida-backend --update-env && pm2 save'"

# ── 8. Health check ───────────────────────────────────────────────────────────
echo "==> Running health check..."
sleep 5
HEALTH=$(ssh "$PROD" "curl -sf http://127.0.0.1:8060/api/health > /dev/null && echo OK || echo FAIL")
CAPTCHA=$(ssh "$PROD" "curl -sf http://127.0.0.1:8060/api/auth/captcha > /dev/null && echo OK || echo FAIL")

echo "  API health : $HEALTH"
echo "  Captcha    : $CAPTCHA"

# ── 9. Cleanup local temp ─────────────────────────────────────────────────────
rm -rf "$TMPDIR"

echo ""
if [ "$HEALTH" = "OK" ] && [ "$CAPTCHA" = "OK" ]; then
  echo "  Production successfully deployed: $SHORT"
  echo "  https://uridageomap.upsdc.gov.in"
else
  echo "  WARNING: Deploy pushed but health checks failed."
  echo "  Check logs: ssh root@192.168.190.112 'sudo -Hu uridaapp bash -lc \"pm2 logs urida-backend --lines 50 --nostream\"'"
  exit 1
fi
