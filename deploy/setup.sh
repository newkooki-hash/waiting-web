#!/usr/bin/env bash
# Ubuntu 24.04 새 서버를 한 번에 설정한다. root(sudo)로 실행:
#   sudo DOMAIN=waiting.orandabowling.co.kr bash setup.sh
set -euo pipefail

DOMAIN="${DOMAIN:-waiting.orandabowling.co.kr}"
ADMIN_DOMAIN="${ADMIN_DOMAIN:-admin.orandabowling.co.kr}"
REPO="${REPO:-https://github.com/newkooki-hash/waiting-web.git}"
APP_DIR=/opt/waiting-web
DATA_DIR=/var/lib/waiting-web
ENV_FILE=/etc/waiting-web.env

[ "$(id -u)" -eq 0 ] || { echo "root 권한으로 실행하세요 (sudo)"; exit 1; }

echo "== 패키지 =="
apt-get update -y
apt-get install -y curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

echo "== Node.js 24 =="
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "== Caddy =="
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "== 사용자·폴더 =="
id waiting >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin waiting
mkdir -p "$DATA_DIR" /var/backups/waiting-web
chown waiting:waiting "$DATA_DIR" /var/backups/waiting-web

echo "== 코드 =="
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO" "$APP_DIR"
fi
chown -R waiting:waiting "$APP_DIR"

echo "== 환경변수 파일 =="
if [ ! -f "$ENV_FILE" ]; then
  cp "$APP_DIR/.env.example" "$ENV_FILE"
  {
    echo ""
    echo "# --- 운영 설정 (setup.sh가 추가) ---"
    echo "NODE_ENV=production"
    echo "BASE_URL=https://$DOMAIN"
    echo "ADMIN_HOST=$ADMIN_DOMAIN"
    echo "DB_FILE=$DATA_DIR/waiting.db"
    echo "PORT=3000"
  } >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo ">> $ENV_FILE 를 열어 비밀번호와 API 키를 채우세요. (README 참고)"
fi

echo "== systemd =="
cp "$APP_DIR/deploy/waiting-web.service" /etc/systemd/system/waiting-web.service
systemctl daemon-reload
systemctl enable waiting-web

echo "== Caddy 설정 =="
sed -e "s/__DOMAIN__/$DOMAIN/" -e "s/__ADMIN_DOMAIN__/$ADMIN_DOMAIN/" "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

echo "== 백업 크론 (매일 04:00) =="
echo "0 4 * * * waiting $APP_DIR/deploy/backup.sh >> /var/log/waiting-backup.log 2>&1" > /etc/cron.d/waiting-backup
chmod 644 /etc/cron.d/waiting-backup
chmod +x "$APP_DIR"/deploy/*.sh

echo
echo "완료. 다음 순서:"
echo "  1) sudo nano $ENV_FILE   (ADMIN_PASSWORD, CODE_SECRET, 카카오/네이버/솔라피 키)"
echo "  2) sudo systemctl restart waiting-web"
echo "  3) https://$DOMAIN 접속 확인"
