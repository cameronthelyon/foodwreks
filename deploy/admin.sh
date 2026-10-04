#!/bin/bash
# Make someone a platform admin and print their one-time set-password link.
#   sudo /opt/freeheld/deploy/admin.sh you@freeheld.io "Your Name"
set -euo pipefail
[ $# -ge 1 ] || { echo "Usage: $0 <email> [\"Full Name\"]"; exit 1; }
cd /opt/freeheld
exec sudo -u freeheld bash -c 'set -a; . /etc/freeheld/freeheld.env; set +a; exec node --disable-warning=ExperimentalWarning scripts/create-admin.js "$@"' _ "$@"
