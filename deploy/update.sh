#!/bin/bash
# Release a new version: pull, test, restart, check. Run as root on the server.
#   sudo /opt/freeheld/deploy/update.sh            (the branch it is on)
#   sudo /opt/freeheld/deploy/update.sh some-branch
set -euo pipefail
APP_DIR=/opt/freeheld
BRANCH="${1:-$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD)}"

before=$(git -C "$APP_DIR" rev-parse --short HEAD)
git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
git -C "$APP_DIR" checkout --quiet -B "$BRANCH" "origin/$BRANCH"
after=$(git -C "$APP_DIR" rev-parse --short HEAD)
echo "== $before -> $after"

# The test suite needs nothing installed and touches no network.
if ! (cd "$APP_DIR" && npm test --silent >/tmp/freeheld-test.log 2>&1); then
  echo "!! Tests failed; rolling back to $before. Details: /tmp/freeheld-test.log"
  git -C "$APP_DIR" checkout --quiet -B "$BRANCH" "$before"
  exit 1
fi

systemctl restart freeheld
sleep 2
if curl -fsS http://127.0.0.1:3000/healthz >/dev/null; then
  echo "== Running $after"
else
  echo "!! Not answering after restart; rolling back to $before"
  git -C "$APP_DIR" checkout --quiet -B "$BRANCH" "$before"
  systemctl restart freeheld
  exit 1
fi
