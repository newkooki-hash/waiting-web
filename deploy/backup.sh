#!/usr/bin/env bash
# DB 일관 백업(VACUUM INTO) 후 14일 지난 백업 삭제. 크론에서 waiting 사용자로 실행.
set -euo pipefail
DB_FILE="${DB_FILE:-/var/lib/waiting-web/waiting.db}"
OUT_DIR="${OUT_DIR:-/var/backups/waiting-web}"
OUT="$OUT_DIR/waiting-$(date +%Y%m%d-%H%M%S).db"

node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("VACUUM INTO \x27" + process.argv[2].replace(/\x27/g, "") + "\x27");
' "$DB_FILE" "$OUT" 2>/dev/null

chmod 600 "$OUT"
find "$OUT_DIR" -name 'waiting-*.db' -mtime +14 -delete
echo "$(date -Is) backup ok: $OUT"
