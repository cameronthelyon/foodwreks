#!/bin/bash
# Freeheld server setup for Ubuntu 24.04 (a DigitalOcean droplet or any VPS).
#
# Paste this whole file into "User data" when creating the droplet, after
# editing the four settings below. It also runs by hand, as root, any time:
# every step is safe to repeat.
#
# Settings live in /etc/freeheld/freeheld.env (values with spaces are quoted,
# so both systemd and a shell can read the file).
#
# What it does: installs Node.js 22 and Caddy (automatic HTTPS), clones the
# code to /opt/freeheld, writes the settings file with a fresh secret,
# starts Freeheld as a service, opens only ports 22/80/443, and installs
# Litestream for continuous off-site backups (switched on once you add
# storage keys). Log: /var/log/freeheld-setup.log
set -euo pipefail
exec > >(tee -a /var/log/freeheld-setup.log) 2>&1

# ---- Edit these ------------------------------------------------------------
DOMAIN="freeheld.io"
SUPPORT_EMAIL="info@freeheld.io"
REPO_URL="https://github.com/cameronthelyon/foodwreks.git"
BRANCH="main"
# -----------------------------------------------------------------------------

APP_DIR=/opt/freeheld
DATA_DIR=/var/lib/freeheld
CONF_DIR=/etc/freeheld
ENV_FILE=$CONF_DIR/freeheld.env
LITESTREAM_VERSION=v0.3.13

echo "== Freeheld setup $(date -u +%FT%TZ)"
export DEBIAN_FRONTEND=noninteractive

# 1. Packages: Node.js 22 (NodeSource), Caddy (Ubuntu), basics.
apt-get update -y
apt-get install -y ca-certificates curl git sqlite3 ufw caddy unattended-upgrades
if ! node --version 2>/dev/null | grep -q '^v2[2-9]'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node --version

# 2. A user with no login shell that owns the data.
id freeheld >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin freeheld
install -d -o freeheld -g freeheld -m 750 "$DATA_DIR" "$DATA_DIR/backups"
install -d -m 750 "$CONF_DIR"

# 3. The code. A private repository needs a deploy key first (deploy/README.md).
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --quiet origin "$BRANCH" && git -C "$APP_DIR" checkout --quiet -B "$BRANCH" "origin/$BRANCH"
elif ! git clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP_DIR"; then
  echo "!! Could not clone $REPO_URL. If the repository is private, add a deploy key (deploy/README.md) and run this script again."
  exit 1
fi
chown -R root:root "$APP_DIR"

# 4. Settings. Created once; never overwritten, so the secret survives re-runs.
if [ ! -f "$ENV_FILE" ]; then
  umask 077
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=3000
BASE_URL=https://$DOMAIN
APP_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
DATABASE_PATH=$DATA_DIR/freeheld.db
BACKUP_DIR=$DATA_DIR/backups
TRUST_PROXY=1
BRAND_NAME=Freeheld
SUPPORT_EMAIL=$SUPPORT_EMAIL
SOURCE_URL=${REPO_URL%.git}
SIGNUPS_OPEN=0

# Email: prints to the log until you add a provider key, then:
#   EMAIL_PROVIDER=postmark
#   POSTMARK_TOKEN=...
EMAIL_PROVIDER=console
EMAIL_FROM="Freeheld <reservations@$DOMAIN>"

# Texting stays off until a restaurant needs it (docs/INTEGRATIONS.md).
SMS_PROVIDER=none

# License payments (docs/INTEGRATIONS.md):
# PLATFORM_STRIPE_SECRET_KEY=
# PLATFORM_STRIPE_WEBHOOK_SECRET=
EOF
  chown root:freeheld "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  echo "== Wrote $ENV_FILE with a new APP_SECRET. Copy it to your password manager."
fi

# 5. The service.
cat > /etc/systemd/system/freeheld.service <<EOF
[Unit]
Description=Freeheld reservations
After=network.target

[Service]
User=freeheld
Group=freeheld
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable freeheld
systemctl restart freeheld

# 6. HTTPS in front. Caddy gets the certificate once DNS points here.
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}

www.$DOMAIN {
	redir https://$DOMAIN{uri} permanent
}
EOF
systemctl enable caddy
systemctl reload caddy || systemctl restart caddy

# 7. Firewall: SSH, HTTP, HTTPS only.
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# 8. Continuous off-site backup. Installed now, switched on by adding keys
#    to /etc/freeheld/litestream.env (deploy/README.md, step 6).
if ! command -v litestream >/dev/null; then
  curl -fsSL -o /tmp/litestream.deb "https://github.com/benbjohnson/litestream/releases/download/$LITESTREAM_VERSION/litestream-$LITESTREAM_VERSION-linux-amd64.deb"
  dpkg -i /tmp/litestream.deb
  rm -f /tmp/litestream.deb
fi
cp "$APP_DIR/deploy/litestream.yml" /etc/litestream.yml
if [ ! -f "$CONF_DIR/litestream.env" ]; then
  umask 077
  cat > "$CONF_DIR/litestream.env" <<'EOF'
# Fill in, then: systemctl enable --now litestream
# DigitalOcean Spaces example: LITESTREAM_ENDPOINT=https://sfo3.digitaloceanspaces.com  LITESTREAM_REGION=sfo3
LITESTREAM_BUCKET=
LITESTREAM_ENDPOINT=
LITESTREAM_REGION=
LITESTREAM_ACCESS_KEY_ID=
LITESTREAM_SECRET_ACCESS_KEY=
EOF
fi
install -d /etc/systemd/system/litestream.service.d
printf '[Service]\nEnvironmentFile=%s/litestream.env\n' "$CONF_DIR" > /etc/systemd/system/litestream.service.d/env.conf
systemctl daemon-reload
if grep -q '^LITESTREAM_BUCKET=.\+' "$CONF_DIR/litestream.env"; then
  systemctl enable litestream
  systemctl restart litestream
fi

# 9. Check.
sleep 2
if curl -fsS http://127.0.0.1:3000/healthz >/dev/null; then
  echo "== Freeheld is running. Next: point DNS for $DOMAIN here, then open https://$DOMAIN"
else
  echo "!! Freeheld did not answer. See: journalctl -u freeheld -n 50"
  exit 1
fi
