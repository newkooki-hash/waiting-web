#!/usr/bin/env bash
# 새 버전 반영: sudo bash /opt/waiting-web/deploy/update.sh
set -euo pipefail
sudo -u waiting git -C /opt/waiting-web pull --ff-only
systemctl restart waiting-web
sleep 2
systemctl is-active waiting-web
