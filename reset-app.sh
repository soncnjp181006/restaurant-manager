#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# reset-app.sh — dọn sạch DB & khôi phục app về trạng thái xuất xưởng
#
# Làm gì:
#   1. Backup mysqldump TOÀN BỘ database vào backups/mysql/pre-reset-<UTC>.sql
#   2. Xóa user + user_role + toàn bộ dữ liệu gắn user (đơn hàng, chấm công,
#      audit, tracking, sync event…) — cùng phạm vi đã duyệt, xem
#      migrations/scripts/wipe-users-and-activity.cjs
#   3. --fresh-sync: truncate change_log + xóa tracking_events (sync/analytics
#      về mốc 0)
#   4. Restart dbproxy + gateway (xóa cache trong RAM: kinds/revocation…)
#   5. Kiểm chứng: /auth/status phải trả needsBootstrap=true, các bảng wiped = 0
#
# SAU KHI CHẠY: app về như mới — đăng nhập bằng PIN 0000 → app bắt buộc
# tạo tài khoản Admin mới. Terminal đang mở cần bấm Settings → Cache →
# Reload cache một lần để xóa cache local (IndexedDB).
#
# Dữ liệu GIỮ NGUYÊN: menu, category, menu_item, tax, payment_type, printer,
# floor, floor_table, kitchen, settings, inventory, _schema_migration.
#
# Dùng:  ./reset-app.sh            (hỏi xác nhận)
#        ./reset-app.sh --yes      (chạy ngay, không hỏi)
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

ASSUME_YES=false
[[ "${1:-}" == "--yes" ]] && ASSUME_YES=true

log()  { printf '\033[36m[reset-app]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[reset-app] LỖI:\033[0m %s\n' "$*" >&2; exit 1; }

# ---- 0. môi trường ---------------------------------------------------------
[[ -f .env ]] || fail "Thiếu file .env ở repo root (MYSQL_*, SURREAL_*…)"
set -a
# shellcheck disable=SC1091
source .env
set +a

command -v node >/dev/null 2>&1 || fail "Cần node trong PATH"
# Pick a docker CLI that can actually reach the daemon — the WSL interop shim
# `docker` may exist on PATH yet print "could not be found" and exit 0.
pick_docker() {
  local cand
  for cand in docker docker.exe; do
    if command -v "$cand" >/dev/null 2>&1 && "$cand" version --format '{{.Server.Version}}' >/dev/null 2>&1; then
      printf '%s' "$cand"
      return 0
    fi
  done
  return 1
}
DOCKER="$(pick_docker)" || fail "Cần docker CLI kết nối được daemon (docker hoặc docker.exe trên WSL)."
log "Dùng docker CLI: $DOCKER ($($DOCKER version --format '{{.Server.Version}}'))"

MYSQL_CONTAINER="${MYSQL_CONTAINER:-restaurant-pos-mysql-1}"
MYSQL_DB="${MYSQL_DB:-restaurant_manager}"
STATUS_URL="${GATEWAY_STATUS_URL:-http://localhost:3142/auth/status}"

# ---- 1. xác nhận -----------------------------------------------------------
if ! $ASSUME_YES; then
  log "Sẽ THỰC HIỆN: backup → xóa user + dữ liệu gắn user + fresh-sync → restart dbproxy/gateway."
  log "App sẽ về như mới (chưa có user — đăng nhập PIN 0000 để tạo Admin)."
  read -r -p "Gõ YES để tiếp tục: " answer
  [[ "$answer" == "YES" ]] || fail "Đã hủy."
fi

# ---- 2. backup -------------------------------------------------------------
TS="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="backups/mysql/pre-reset-$TS.sql"
mkdir -p backups/mysql
log "Backup mysqldump → $BACKUP"
$DOCKER exec "$MYSQL_CONTAINER" sh -c "mysqldump -h127.0.0.1 -u$MYSQL_USER -p$MYSQL_PASSWORD --single-transaction --no-tablespaces --routines --triggers --set-gtid-purged=OFF $MYSQL_DB" > "$BACKUP" 2>/dev/null \
  || fail "mysqldump thất bại — DỪNG, không xóa gì."
[[ -s "$BACKUP" ]] || fail "File backup rỗng — DỪNG."
grep -q "INSERT INTO \`records\`" "$BACKUP" || fail "Backup không chứa dữ liệu records — DỪNG."
log "Backup OK ($(du -h "$BACKUP" | cut -f1))"

# ---- 3. wipe ---------------------------------------------------------------
log "Xóa user + dữ liệu gắn user (--fresh-sync)…"
node migrations/scripts/wipe-users-and-activity.cjs --yes --fresh-sync

# ---- 4. restart service để xóa cache trong RAM -----------------------------
log "Restart dbproxy + gateway…"
$DOCKER compose restart dbproxy gateway >/dev/null 2>&1 || {
  log "docker compose restart không chạy được — bỏ qua (không ảnh hưởng kết quả wipe)."
}
sleep 5

# ---- 5. kiểm chứng ---------------------------------------------------------
log "Kiểm chứng…"
VERIFY="$($DOCKER exec "$MYSQL_CONTAINER" sh -c "mysql -u$MYSQL_USER -p$MYSQL_PASSWORD -h 127.0.0.1 $MYSQL_DB -N -e \"
SELECT CONCAT(
  (SELECT COUNT(*) FROM records WHERE table_name IN ('user','user_role','order','time_entry','audit_log','tracking','sync_event')), '|',
  (SELECT COUNT(*) FROM change_log), '|',
  (SELECT COUNT(*) FROM records WHERE table_name IN ('menu','menu_item','category','tax','payment_type','printer','floor','floor_table','kitchen','setting','_schema_migration'))
)\" 2>/dev/null" || echo "verify-failed")"
WIPED_COUNT="${VERIFY%%|*}"; REST="${VERIFY#*|}"; CL_COUNT="${REST%%|*}"; KEPT_COUNT="${REST##*|}"
[[ "$WIPED_COUNT" == "0" ]] || fail "Vẫn còn $WIPED_COUNT dòng dữ liệu đã xóa — kiểm tra lại."
# change_log có thể đã có vài dòng mới do client ghi lại ngay sau restart — chỉ informational.
log "Wiped tables: 0 dòng · giữ catalog/schema: $KEPT_COUNT dòng · change_log (mới sau restart): $CL_COUNT"

NEEDS_BOOTSTRAP="$(curl -s --max-time 8 "$STATUS_URL" 2>/dev/null || true)"
[[ "$NEEDS_BOOTSTRAP" == *'"needsBootstrap":true'* ]] || log "CẢNH BÁO: $STATUS_URL chưa xác nhận needsBootstrap (gateway có thể đang khởi động lại — thử lại sau vài giây)."

# ---- 6. tổng kết -----------------------------------------------------------
cat <<DONE

✅ App đã về trạng thái xuất xưởng.
   • Backup trước reset : $BACKUP
   • Đăng nhập lần đầu  : PIN 0000  →  app bắt buộc tạo tài khoản Admin mới
   • Terminal đang mở   : Settings → Cache → Reload cache (xóa cache local)
   • Khôi phục dữ liệu cũ (nếu cần): $DOCKER exec -i $MYSQL_CONTAINER sh -c \
"mysql -u$MYSQL_USER -p$MYSQL_PASSWORD $MYSQL_DB" < "$BACKUP"

DONE
