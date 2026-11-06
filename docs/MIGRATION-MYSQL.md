# Báo cáo chuyển đổi PostgreSQL → MySQL

> **Ngày hoàn thành:** 2026-11-03 · **Nhánh:** `refactor-db`
> **Phạm vi:** Toàn bộ hệ thống đang chạy PostgreSQL (theo [`MIGRATION-SURREAL-TO-POSTGRES.md`](MIGRATION-SURREAL-TO-POSTGRES.md)) được chuyển sang **MySQL 8** trong Docker, **giữ nguyên dữ liệu**, giữ nguyên giao thức wire của `dbproxy` nên frontend và 5 sidecar không đổi một dòng nghiệp vụ nào. Kiểm thử ở từng bước.

---

## 1. Mục tiêu và kết quả

| # | Yêu cầu | Kết quả |
|---|---------|---------|
| 1 | Kho dữ liệu chuyển sang MySQL | ✅ `restaurant-manager-dbproxy` ghi/đọc 100% trên MySQL 8: `records` (kiểu `JSON`) + 5 bảng metadata/change_log. Không còn một truy vấn PostgreSQL nào. |
| 2 | Không mất dữ liệu | ✅ 7.231 dòng / 6 bảng chuyển từ PostgreSQL sang MySQL; **đối chiếu từng ô** (canonical JSON) — tất cả khớp. `change_log` giữ nguyên `seq` để watermark sync/LIVE không đổi. |
| 3 | Mirror tracking cũng sang MySQL | ✅ `tracking-api/src/mysql-store.js` (thay `postgres-store.js`), biến env `TRACKING_MYSQL_*`, `/health` báo `mysqlMirror` / `mysqlMirrorFailures`. |
| 4 | Docker chạy MySQL | ✅ service `mysql` (mysql:8.0) + volume `mysql-data` + healthcheck thật (`mysql -e 'SELECT 1'`); service `backup` đổi sang `mysqldump`; đã **dump và restore** để chứng minh backup dùng được. |
| 5 | Không để sót tên PostgreSQL | ✅ `pg` bị gỡ khỏi `package.json` của `dbproxy` và `tracking-api`; `.env`, `.env.example`, `.env.local`, `.gitignore`, `docker-compose*.yml`, README, ADR 0006 đều đổi tên. Tài liệu cũ được **đổi tên thành `MIGRATION-SURREAL-TO-POSTGRES.md`** và gắn nhãn "tài liệu lịch sử" thay vì xoá. |
| 6 | Test lại toàn bộ | ✅ 61/61 dbproxy · 30/30 tracking (0 skip) · 27/27 sync · 635/635 vitest · 8/8 sync-compat · full-stack smoke PASS · 0 lỗi lint. |
| 7 | Chạy app thật | ✅ Đăng nhập PIN `1234` → CLOCK IN → màn Đơn hàng/Thực đơn đọc dữ liệu thật từ MySQL; ghi từ UI tạo `time_entry` + `audit_log` (DEFINE EVENT) + `change_log` tăng. |

---

## 2. Kiến trúc: chỉ thay lớp dưới, giữ nguyên lớp trên

```
Browser (SDK surrealdb npm — KHÔNG đổi)  →  ws://gateway:3142/rpc (JWT)  →  ws-relay
        │
        ▼
dbproxy (Node, giao thức /rpc CBOR — KHÔNG đổi)          engine.mjs / parser.mjs / eval.mjs
        │  chỉ store.mjs + server.mjs đổi phương ngữ              (giữ nguyên, không chứa SQL)
        ▼
MySQL 8 (service `mysql` trong docker-compose.yml)
  ├─ records          (table_name, id, data JSON)   ← toàn bộ dữ liệu POS
  ├─ field_kinds      học kiểu wire per-field
  ├─ unique_indexes   43 DEFINE INDEX UNIQUE → enforce khi ghi
  ├─ field_defaults   280 DEFINE FIELD DEFAULT → áp khi CREATE
  ├─ event_defs       9 DEFINE EVENT (audit_log) → chạy khi ghi
  ├─ change_log       seq BIGINT AUTO_INCREMENT (thay changefeed)
  └─ tracking_events  (mirror SQL của tracking-api, tùy chọn)
```

`engine.mjs`, `parser.mjs`, `eval.mjs`, `cbor.mjs` **không sửa** — chúng gọi API của store (`getRecords`, `writeRecord`, `appendChange`…), nên toàn bộ SurrealQL, FETCH, GROUP, LIVE, `$auth` và bcrypt vẫn chạy như cũ. Frontend `src/` (202 file dùng `useDB`) và code truy vấn của 5 sidecar: 0 dòng thay đổi.

Các file thực sự đổi: `dbproxy/src/store.mjs` (viết lại lớp lưu trữ), `server.mjs` (pool mysql2), `rpc.mjs` (`pool.connect()` → `pool.getConnection()`, 1 chỗ), `live.mjs` (2 chỗ), `test/integration.test.mjs`, `dbproxy/package.json`, `docker-compose.yml`, `docker-compose.analytics.yml`, `.env*`, `tracking-api/*`, `migrations/scripts/*`, README/ADR.

---

## 3. Ánh xạ phương ngữ PostgreSQL → MySQL

| PostgreSQL | MySQL 8 | Lý do / ghi chú |
|---|---|---|
| `jsonb` | `JSON` | driver tự parse về object JS như `pg` từng làm; `NULL` cho cột json giữ nguyên. |
| `$1, $2` | `?, ?` | placeholder của mysql2 (escaping an toàn). |
| `ON CONFLICT (…) DO UPDATE SET x = EXCLUDED.x` | `… VALUES (?, ?) AS new ON DUPLICATE KEY UPDATE x = new.x` | row-alias (MySQL 8.0.19+); đã kiểm chứng chạy được trên image `mysql:8.0`. |
| `INSERT … RETURNING seq` | `result.insertId` | `seq` là `BIGINT AUTO_INCREMENT`. |
| `id = ANY($1)` | `id IN (?, ?, …)` | mở rộng danh sách placeholder. |
| `data->>'col' = $v` (so sánh **text**) | `JSON_EXTRACT(data, ?) = CAST(? AS JSON)` (so sánh **kiểu**) | jsonb so sánh dạng text nên `65000` (số) khớp `"65000"` (chuỗi); MySQL so sánh theo kiểu JSON — đúng ngữ nghĩa SurrealDB hơn và chặt hơn. Đã đo: number/bool/string khớp đúng từng loại, cross-type không khớp. |
| `bigserial` | `BIGINT AUTO_INCREMENT` | chèn `seq` tường minh khi migrate vẫn hợp lệ và auto-increment tiếp tục từ max+1 (đo: chèn 5000 → lần kế 5001). |
| `timestamptz DEFAULT now()` | `TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3)` (+ `ON UPDATE` cho `updated_at`) | pool đặt `timezone: '+00:00'` để `DATETIME` được parse/escape theo UTC, không theo zone máy. |
| collation mặc định `en_US`/`utf8mb4_0900_ai_ci` | `utf8mb4_bin` cho mọi bảng | **bắt buộc**: các collation `*_ci`/`*_ai` gộp hoa-thường và dấu tiếng Việt thành một khoá, sẽ làm `id` va chạm nhau. Cờ `--collation-server=utf8mb4_bin` nằm trong compose. |
| `pg_isready` | `mysql -u… -p… -e 'SELECT 1'` | healthcheck thật, đã chạy healthy. |
| `pg_dump -Fc` + `crond` busybox | `mysqldump --single-transaction --no-tablespaces --routines --triggers` + vòng lặp `sleep` tới mốc 00:00/12:00 UTC | image `mysql:8.0` không có `crond`; `--no-tablespaces` để user backup không cần quyền `PROCESS`. |
| `TRACKING_PG_SCHEMA` (search_path) | **bỏ** | MySQL không có search_path — database chứa bảng mirror chính là `TRACKING_MYSQL_DB` (hoặc path của URL). |
| `POSTGRES_USER/PASSWORD/DB/HOST_PORT`, volume `postgres-data`, `backups/postgres` | `MYSQL_USER/PASSWORD/ROOT_PASSWORD/DB/HOST_PORT`, volume `mysql-data`, `backups/mysql` | `.env` dev giữ nguyên user/password cũ, thêm `MYSQL_ROOT_PASSWORD`, cổng host `3307` (3306 để trống cho máy cài MySQL sẵn). |

---

## 4. Docker

`docker-compose.yml`:

- service `postgres` → **`mysql`** (mysql:8.0) với `command:` gồm `--character-set-server=utf8mb4 --collation-server=utf8mb4_bin --transaction-isolation=READ-COMMITTED --max-allowed-packet=64M --innodb-buffer-pool-size=256M`. READ-COMMITTED cho giống isolated mức PostgreSQL từng dùng; `max_allowed_packet` cần cho batch insert lúc migrate.
- service `dbproxy`: `DB_HOST=mysql`, `DB_PORT=3306`, `DB_USER/PASS` lấy từ `MYSQL_*`; port publish `8000` giữ nguyên (`${SURREAL_HOST_PORT:-8000}`) nên mọi sidecar và `.env` cũ không phải đổi.
- 5 sidecar giữ `ws://dbproxy:8000/rpc` — không đổi.
- service `backup`: `mysqldump` ra `./backups/mysql/mysql-<UTC timestamp>.sql`, giữ `BACKUP_RETENTION_COUNT=7`.
- `docker-compose.analytics.yml`: không còn container DB thứ hai; overlay chỉ cấp `TRACKING_MYSQL_URL` cho service `tracking` để bật mirror trên đúng instance MySQL chính.
- `docker compose config -q` ✅ cho stack mặc định (mirror vô hiệu hoàn toàn) và ✅ khi ghép overlay (chỉ warning `TRACKING_MYSQL_PASS` chưa set, đúng thiết kế opt-in).

---

## 5. Di chuyển dữ liệu PostgreSQL → MySQL

Script: **`migrations/scripts/migrate-pg-to-mysql.cjs`** (mới). Nó **không cần driver PostgreSQL**: dữ liệu nguồn đọc từ file JSON do `psql` xuất ra, nên trong repo không còn dependency `pg` nào.

```bash
# 1. export 6 bảng từ container PostgreSQL cũ (volume restaurant-pos_postgres-data)
docker run -d --name pos-pg-old -p 5435:5432 \
  -e POSTGRES_USER=restaurant -e POSTGRES_PASSWORD=… -e POSTGRES_DB=restaurant_manager \
  -v restaurant-pos_postgres-data:/var/lib/postgresql/data postgres:16-alpine
for t in records change_log field_kinds unique_indexes field_defaults event_defs; do
  docker exec pos-pg-old psql -U restaurant -d restaurant_manager -At \
    -c "SELECT COALESCE(json_agg(to_jsonb(x))::text,'[]') FROM $t x" > scratch/pg-export/$t.json
done

# 2. nạp vào MySQL + tự đối chiếu
node migrations/scripts/migrate-pg-to-mysql.cjs --from-dir scratch/pg-export --truncate
```

Kết quả chạy thật (2026-11-03):

```
read  records 2273 · change_log 4548 · field_kinds 78 · unique_indexes 43 · field_defaults 280 · event_defs 9
loaded records 502ms · change_log 918ms · (4 bảng metadata còn lại < 20ms)
OK  records: 2273 → 2273          OK  change_log: 4548 → 4548
OK  field_kinds: 78 → 78          OK  unique_indexes: 43 → 43
OK  field_defaults: 280 → 280     OK  event_defs: 9 → 9
OK  records per app table: 44 tables
OK  change_log seq watermark: max=4548 next_auto_increment=4549
```

Bộ đối chiếu không chỉ đếm dòng: nó so **từng ô** (JSON so sau khi sắp khoá, timestamp cho phép lệch 1 ms), so số bảng nghiệp vụ, và kiểm `AUTO_INCREMENT` phải lớn hơn `seq` cao nhất. Script từ chối nạp vào MySQL đã có dữ liệu nếu thiếu `--truncate`.

**Control âm (chứng minh cổng kiểm không "xanh giả"):** sửa cố ý một giá trị `field_kinds.kind` trong MySQL → script báo `MISMATCH field_kinds … row _schema_migration:applied_at column "kind" differs`, exit 1; khôi phục → chạy lại ra OK, exit 0.

Nhánh nhập dữ liệu cũ (SurrealDB → proxy) vẫn còn, đổi tên thành `migrations/scripts/migrate-surreal-to-mysql.cjs` — nó chỉ nói chuyện với dbproxy qua SDK nên không có gì phải đổi ngoài tên/nhãn.

---

## 6. Bằng chứng kiểm thử

| Lớp | Lệnh | Kết quả |
|---|---|---|
| Codec CBOR | `node --test test/cbor.test.mjs` | 13/13 pass |
| Parser SurrealQL | `node --test test/parser.test.mjs` | 34/34 pass |
| Evaluator | `node --test test/eval.test.mjs` | 12/12 pass |
| **Integration SDK ↔ dbproxy ↔ MySQL** | `node --test test/integration.test.mjs` | **2/2 pass, 0 skip** (CRUD, FETCH, ONLY+`type::record`, bcrypt login, NONE, datetime, UNIQUE, DEFINE DEFAULT, INFO, SHOW CHANGES, LIVE CREATE/UPDATE/DELETE, RELATE, GROUP ALL, per-statement ERR) |
| Toàn bộ dbproxy | `cd dbproxy && npm test` | **61/61 pass, 0 skip** — chạy trên thể MySQL do compose quản lý |
| Tương thích sync-service | `node dbproxy/scripts/verify-sync-compat.cjs` | **8/8 PASS** (`SHOW CHANGES`, cursor, watermark BigInt) |
| Full-stack qua gateway | `node dbproxy/scripts/verify-fullstack-gateway.cjs` | **PASS**: login PIN 1234 (bcrypt trong dbproxy) → `/auth/db-token` → ws-relay JWT → `authenticate` → query có FETCH → LIVE `["CREATE"]` |
| tracking-api | `npm run test:tracking` (có `TRACKING_MYSQL_URL` thật) | **30/30 pass, 0 skip** (trước đây 26 pass + 2 skip; 2 skip giờ chạy thật, cộng 4 case mới cho parser URL/DDL) |
| sync | `npm run test:sync` | 27/27 pass |
| Frontend | `npm test` (vitest) | 635/635 pass, 85 file |
| Lint | `npm run lint` | 0 error (279 warning, không có warning nào thuộc file đã sửa) |
| Backup | `mysqldump` trong service `backup` | dump 3,53 MB → restore sang DB `rm_restore`: 2.274 records / 4.554 change_log / 9 event_defs, `MAX(seq)=4554`; sau đó xoá DB restore |
| Migration control | xem §5 | phát hiện lệch thật, exit 1 |

Ghi chú: test dbproxy và tracking chạy trên database riêng `restaurant_manager_test` để không đụng dữ liệu dev vừa migrate.

---

## 7. Kiểm tra app thật (đã chạy)

```
Vite dev (host)      → http://localhost:5173   (React app, 0 dòng đổi)
Gateway (compose)    → http://localhost:3142   /health 200
dbproxy (compose)    → ws://127.0.0.1:8007/rpc
MySQL (compose)      → 127.0.0.1:3307  (healthy)
tracking (compose)   → http://127.0.0.1:3138/health → {"mysqlMirror":"configured","mysqlMirrorFailures":0}
```

| Bước | Hành động | Kết quả |
|---|---|---|
| 1 | Mở app | Màn hình Đăng nhập (PIN) — banner header **"Đã đồng bộ"** = kết nối DB OK |
| 2 | Log console | `Successfully connected to SurrealDB` (client cũ, nay là dbproxy→MySQL) + các query thật trả `Array(1)` |
| 3 | Bấm PIN `1234` → tự submit | `Cần chấm công` — đúng luồng, bcrypt chạy trong dbproxy trên MySQL |
| 4 | Bấm `CHẤM CÔNG` | Vào hệ thống: Thực đơn/Đơn hàng/Tổng hợp/Bếp/…; URL `/orders` |
| 5 | Mở **Thực đơn** | Dữ liệu nghiệp vụ thật từ MySQL: `ĐƠN# 2 · BÀN 11 · Cà phê sữa đá · ₫29,000 · Món (2) · ₫58,000` |
| 6 | Ghi từ UI đo được | `time_entry` 1 → **2**, `audit_log` 4 → **7** (DEFINE EVENT tự chạy khi đăng nhập/chấm công), `change_log` max seq 4554 → **4562** |
| 7 | `POST /tracking` (mirror đang bật) | HTTP 201 → bản ghi vào store **và** 1 dòng `tracking_events` trong MySQL, `payload.payload.note = "mirror proof"` |

---

## 8. Giới hạn và điểm cần biết

1. **`utf8mb4_bin` là điều kiện đúng, không phải tuỳ chọn.** Nếu chạy MySQL ngoài compose với collation mặc định `*_ai_ci`, `id` kiểu `Order:2` và `order:2` sẽ thành một bản ghi. Giữ nguyên cờ trong compose (hoặc set cho database).
2. **So sánh unique index nay theo kiểu JSON** (§3): number không còn khớp với chuỗi cùng chữ số. Đây là hướng sát SurrealDB hơn, nhưng nếu dữ liệu cũ từng có index UNIQUE trên một cột vừa số vừa chuỗi thì hành vi khác PostgreSQL — dữ liệu dev hiện tại không có trường hợp nào (43 index đều trên chuỗi).
3. **Độ chính xác số:** `JSON` của MySQL lưu số nguyên ≤ 2^63 và số thực dạng double; giá trị > 2^53 vẫn mất precision ở tầng JS (như `surrealdb` SDK và jsonb trước đây). Tiền vẫn đi dạng string qua `field_kinds='decimal'` nên không bị ảnh hưởng.
4. **Múi giờ:** pool đặt `timezone:'+00:00'`; container MySQL chạy UTC. Nếu migrate sang host có `time_zone` khác, hoặc bỏ tuỳ chọn này, cột `at`/`created_at` sẽ lệch như bug đã bắt được ở §5 trong quá trình phát triển.
5. **`SHOW CHANGES`** vẫn mô phỏng changefeed bằng `change_log` (versionstamp = seq pad 20 số); retention chưa tự dọn — có thể thêm job theo `updated_at` như ghi chú báo cáo cũ.
6. **`Execution model`** không đổi: WHERE/GROUP/SPLIT/FETCH đánh giá trong JS trên dòng lấy từ MySQL; chỉ lookup theo PK đẩy xuống SQL. Ở quy mô hiện tại (44 bảng có dữ liệu, ~2,3 nghìn dòng) đo được 20–33 ms/query qua browser.
7. **`tracking_events`** có chỉ mục `DESC` (MySQL 8 hỗ trợ) và hai khoá phụ, bảng tự tạo khi mirror nhận event đầu tiên; bật/tắt hoàn toàn bằng `TRACKING_MYSQL_*`.
8. **Rollback:** volume `restaurant-pos_postgres-data` và container `pos-pg-old` (port 5435) vẫn còn trên máy dev; dữ liệu MySQL có thể xuất lại bằng dump ở §6. Tài liệu Surreal→PostgreSQL giữ lại dưới tên `MIGRATION-SURREAL-TO-POSTGRES.md`.
9. `docker compose up -d app` **không chạy được trên máy này** (node_modules cài từ Windows thiếu native binding của rolldown/vite cho Linux) — lỗi môi trường, có từ trước và không liên quan DB; Vite chạy trên host như mục 7.

---

## 9. File thay đổi

**Mới:** `migrations/scripts/migrate-pg-to-mysql.cjs`, `tracking-api/src/mysql-store.js`, `tracking-api/src/mysql-store.test.js`, `docs/MIGRATION-MYSQL.md`, `docs/adr/0006-mysql-tracking-mirror.md`.

**Sửa:** `dbproxy/src/store.mjs` (lớp lưu trữ MySQL), `dbproxy/src/server.mjs`, `dbproxy/src/rpc.mjs`, `dbproxy/src/live.mjs`, `dbproxy/test/integration.test.mjs`, `dbproxy/package.json` (+`mysql2`, −`pg`), `docker-compose.yml`, `docker-compose.analytics.yml`, `.env.example`, `.env.local`, `.env` (gitignored), `.gitignore`, `README.md`, `CONSOLIDATION-PLAN.md` (ghi chú dated), `tracking-api/server.js`, `tracking-api/src/services/tracking.service.js` (+ test), `tracking-api/package.json`, `tracking-api/.env.example`.

**Đổi tên:** `migrations/scripts/migrate-surreal-to-pg.cjs` → `migrate-surreal-to-mysql.cjs`; `docs/adr/0006-postgres-tracking-mirror.md` → `0006-mysql-tracking-mirror.md`; `docs/MIGRATION-POSTGRES.md` → `docs/MIGRATION-SURREAL-TO-POSTGRES.md` (kèm nhãn tài liệu lịch sử).

**Xoá:** `tracking-api/src/postgres-store.js` và test của nó (được thay bằng `mysql-store.js` + test tương ứng).

**Không đổi:** toàn bộ `src/` (frontend), `migrations/*.surql`, code truy vấn của 5 sidecar.

---

## 10. Cách chạy

```bash
# .env cần: MYSQL_USER / MYSQL_PASSWORD / MYSQL_ROOT_PASSWORD / MYSQL_DB (/ MYSQL_HOST_PORT),
#           SURREAL_USER / SURREAL_PASS (RPC root của dbproxy), GATEWAY_JWT_SECRET
docker compose up -d --build mysql dbproxy        # hoặc up -d cho cả stack
docker compose ps                                  # mysql healthy, dbproxy Up
node migrations/scripts/migrate-pg-to-mysql.cjs --from-dir scratch/pg-export --truncate   # nếu cần nạp lại data
cd dbproxy && npm test                             # DB_TEST_PORT=3307, DB_TEST_DB=restaurant_manager_test
```

Bật mirror tracking: `docker compose -f docker-compose.yml -f docker-compose.analytics.yml up -d tracking` → `curl http://127.0.0.1:3138/health`.

### Tài khoản đăng nhập (dữ liệu đã migrate, không đổi)

PIN trên màn hình Login: **1234** (đã xác minh lại bằng UI), `0000`, `5555`, `8888`, `9999` (đã xác minh qua API).

### Thông tin kết nối MySQL (máy dev)

| Thành phần | Giá trị |
|---|---|
| Host:port (từ host) | `127.0.0.1:${MYSQL_HOST_PORT:-3306}` — máy này **3307** |
| Trong compose | `mysql:3306`, user app đăng nhập qua `dbproxy:8000/rpc` |
| Database / User / Password | `restaurant_manager` / `restaurant` / `fc3ec04f8907d7032df738bae6951b928d83` |
| Root MySQL | `root` / `f7c4a1cfe080f9db919fb97d9b673783cb44442d91ac16ce` |
| RPC root của dbproxy | `SURREAL_USER` / `SURREAL_PASS` = `restaurant` / `fc3ec04f8907d7032df738bae6951b928d83` |

⚠️ Đổi toàn bộ credential trên trước khi deploy thật.
