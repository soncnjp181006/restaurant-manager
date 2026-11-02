# Báo cáo chuyển đổi toàn bộ DB sang PostgreSQL

> **Ngày hoàn thành:** 2026-11-02 · **Nhánh:** `refactor`
> **Phạm vi:** Toàn bộ dữ liệu của ứng dụng chuyển từ SurrealDB sang **PostgreSQL**, chạy trong **Docker**. Loại bỏ SurrealDB server. Kiểm thử tại từng bước chuyển đổi.

---

## 1. Mục tiêu và kết quả chốt

| # | Yêu cầu | Kết quả |
|---|---------|---------|
| 1 | Chuyển toàn bộ DB sang PostgreSQL | ✅ 100% dữ liệu nằm trong PostgreSQL (`records` jsonb store + metadata). Không còn SurrealDB server. |
| 2 | Đẩy DB vào Docker | ✅ Service `postgres` (postgres:16-alpine) + service `dbproxy` trong `docker-compose.yml`, data nằm ở volume `postgres-data`. |
| 3 | Loại bỏ DB gốc (SurrealDB) | ✅ Service `surrealdb` đã bị xóa khỏi compose; backup chuyển sang `pg_dump`; `.env`/`.env.example`/README cập nhật. |
| 4 | Loại bỏ "python giả DB" | ✅ **Không tồn tại** file Python nào — đã kiểm tra toàn bộ working tree **và toàn bộ lịch sử git** (`git log --all --diff-filter=A -- "*.py"` = rỗng). Không có `requirements.txt`/`pyproject.toml`/`setup.py`. Cả kho không hề có Python, nên không có gì để loại bỏ. Lưu ý: `fake-indexeddb` trong devDependencies là shim **JavaScript** dùng để test lớp IndexedDB của trình duyệt (không phải DB server, không liên quan Python) — được giữ lại vì nó phục vụ 564 test frontend. |
| 5 | Chuyển đến đâu test đến đó | ✅ Mỗi thành phần có test đi kèm, chạy ngay khi viết (chi tiết §6). |
| 6 | Viết file báo cáo | ✅ Chính là file này. |

---

## 2. Kiến trúc

### 2.1 Trước khi chuyển

```
Browser (SDK surrealdb npm, SurrealQL qua WebSocket)
        │  ws://…/rpc (qua gateway ws-relay hoặc trực tiếp)
        ▼
SurrealDB server v3 (surrealkv, ./database)  ←  gateway / api / payments /
   (toàn bộ dữ liệu POS)                        tracking / sync-service
PostgreSQL chỉ là mirror tùy chọn cho tracking (docker-compose.analytics.yml)
```

- Frontend gọi SurrealQL trực tiếp qua SDK `surrealdb` (839 điểm gọi, 202 file dùng `useDB`).
- 5 service backend dùng SDK同一个 (`gateway/src/surreal-client.js` và tương tự).
- `sync-service` replicate branch↔HQ bằng changefeed (`SHOW CHANGES`, `ALTER TABLE … CHANGEFEED`).

### 2.2 Sau khi chuyển

```
Browser (SDK surrealdb npm — GIỮ NGUYÊN, không đổi 1 dòng frontend)
        │  ws://gateway:3142/rpc (JWT upgrade)  →  ws-relay pipe raw frames
        ▼
dbproxy (Node, service mới trong compose)  ←  gateway / api / payments /
        │  nói cùng giao thức /rpc (subprotocol "cbor", CBOR JSON-RPC)     tracking / sync-service
        ▼
PostgreSQL 16 (service `postgres` trong compose)
  ├─ records        (table_name, id, data jsonb)  ← toàn bộ dữ liệu POS
  ├─ field_kinds    học kiểu wire per-field (rid/datetime/decimal/uuid/…)
  ├─ unique_indexes 43 DEFINE INDEX UNIQUE → enforce khi ghi
  ├─ field_defaults 280 DEFINE FIELD DEFAULT → áp khi CREATE
  ├─ event_defs     9 DEFINE EVENT (audit_log) → chạy khi ghi
  ├─ change_log     thay thế changefeed của SurrealDB (LIVE + SHOW CHANGES)
  └─ tracking_events (mirror SQL của tracking-api, tùy chọn)
```

**Nguyên tắc thiết kế:** giữ nguyên giao thức wire của SurrealDB ở tầng trình duyệt/service để **không phải sửa 839 điểm gọi query**. DB gốc (SurrealDB server) bị loại bỏ hoàn toàn; SDK `surrealdb` npm giờ chỉ là một WebSocket client nói JSON-RPC/CBOR với `dbproxy` — mọi thứ nó gửi/gửi về đều được thực thi/phục vụ 100% từ PostgreSQL.

### 2.3 Service mới: `dbproxy/` (~2.600 dòng + test)

| Module | Vai trò |
|--------|---------|
| `src/cbor.mjs` | Codec CBOR (RFC 8949) với đúng các tag Surreal mà SDK dùng (tag 6 NONE, 7 table, 8 record id, 10 decimal, 12 datetime, 37 uuid, 49–51 range, 56 set, 88–94 geometry…). |
| `src/parser.mjs` | Tokenizer + recursive-descent parser SurrealQL cho toàn bộ phương ngữ app dùng: SELECT/CREATE/UPSERT/INSERT/UPDATE/DELETE/RELATE/LIVE/KILL/DEFINE/REMOVE/INFO/SHOW CHANGES/RETURN/USE/LET/BEGIN/COMMIT/CANCEL/SLEEP/THROW/ALTER. |
| `src/eval.mjs` | Đánh giá biểu thức chuẩn Surreal: path flatten qua mảng, NONE vs NULL, INSIDE/CONTAINS(IN/ALL/ANY/NONE), `time::now() - 3d`, `math::*`, `string::*`, `type::record/table`, `object::keys`, `array::union`, **`crypto::bcrypt::compare/generate`**, cast `<string>/<datetime>/<array<string>>`, IF/THEN/ELSE (cả dạng ngoặc nhọn). |
| `src/store.mjs` | Lưu trữ PG: CRUD trên `records`, học `field_kinds`, enforce unique index, áp default, chạy DEFINE EVENT (tạo `audit_log` với `$auth/$before/$after`), ghi `change_log`. |
| `src/engine.mjs` | Thực thi statement: WHERE (kèm đẩy xuống PK cho `id =/IN`), GROUP BY/GROUP ALL + aggregate, ORDER/START/LIMIT, SPLIT, **FETCH hydrate đệ quy** (giữ ngữ nghĩa NONE khi record không tồn tại), CREATE/UPSERT/INSERT (IGNORE, ON DUPLICATE)/UPDATE (SET/MERGE/PATCH/CONTENT)/DELETE/RELATE, ONLY, RETURN. |
| `src/live.mjs` | LIVE SELECT: subscription per-connection, dispatcher poll `change_log`, lọc WHERE, đẩy frame SDK `{result:{id,action,record,result}}`. |
| `src/rpc.mjs` | WS server subprotocol `cbor`: ping/version/use/signin/authenticate/invalidate/let/unset/query/begin/commit/cancel/kill. Mỗi batch = 1 transaction PG + SAVEPOINT per statement (statement lỗi → status ERR, batch chạy tiếp — đúng behavior SurrealDB). |
| `src/auth.mjs` | Root credential từ env (`DB_ROOT_*`), cấp/verify DB access token HS256 (`DB_TOKEN_SECRET`, mặc định dùng `GATEWAY_JWT_SECRET`) — thay cho "Surreal access token" cũ, kèm claims `sub/login/roles` để `$auth` trong event hoạt động. |

---

## 3. Docker

`docker-compose.yml`:

- **BỎ** service `surrealdb` (và volume `./database`).
- **THÊM** `postgres` (postgres:16-alpine, healthcheck `pg_isready`, volume `postgres-data`, host port `${POSTGRES_HOST_PORT:-5432}`).
- **THÊM** `dbproxy` (build từ `dbproxy/Dockerfile`, port nội bộ 8000, publish `${SURREAL_HOST_PORT:-8000}` — giữ tên biến để .env cũ chạy được).
- Toàn bộ `app/payment/sync/tracking/api/gateway` chuyển `ws://surrealdb:8000/rpc` → `ws://dbproxy:8000/rpc` (chỉ đổi host — **không đổi code**).
- Service `backup`: viết lại bằng `pg_dump -Fc` theo lịch cron 00:00/12:00 UTC, giữ `BACKUP_RETENTION_COUNT=7` → `./backups/postgres`.
- `docker-compose.analytics.yml`: postgres đã nằm ở file chính → overlay giờ chỉ bật mirror `tracking_events` trên cùng instance PG đó.

---

## 4. Migration dữ liệu (SurrealDB → PostgreSQL)

Script: `migrations/scripts/migrate-surreal-to-pg.cjs` (đã chạy thành công).

1. Đọc bảng từ `INFO FOR DB` của SurrealDB cũ (chạy tạm trong container, mount `./database` qua volume vì bind mount Windows không hỗ trợ WAL lock của surrealkv).
2. `SELECT *` từng bảng → `UPSERT type::record($t, $id) CONTENT $data` qua dbproxy → record link/datetime/decimal đi đúng CBOR tag → proxy **học lại đúng kiểu wire** từng field.
3. Apply `migrations/latest.surql` (1.711 câu DEFINE) → đăng ký 43 unique index, 280 field default, 9 event audit.
4. In bảng so sánh số dòng từng bảng.

**Kết quả chạy thực tế trên data dev hiện có:** `169/169 bảng khớp số dòng, tổng 2.270 dòng` (44 bảng có dữ liệu, 125 bảng rỗng).

> Migration **không idempotent**: chạy lại cần `TRUNCATE records, field_kinds, change_log, unique_indexes, field_defaults, event_defs;` trước. Cấu trúc `unique_indexes` hiện không backfill-validate dữ liệu cũ (SurrealDB đảm bảo điều đó sẵn).

---

## 5. Những gì KHÔNG đổi

- **Toàn bộ frontend** (`src/`): 0 dòng thay đổi — `db.ts`, 202 file dùng `useDB`, 7 màn hình LIVE query đều chạy nguyên trạng qua proxy.
- **5 service backend**: chỉ đổi env (`SURREAL_URL=ws://dbproxy:8000/rpc`); code truy vấn giữ nguyên vì proxy tương thích phương ngữ.
- **Quy trình auth**: gateway JWT → ws-relay → `authenticate(surrealToken)` — hình thức như cũ, token DB mới do dbproxy phát hành.

---

## 6. Bằng chứng kiểm thử ("chuyển đến đâu test đến đó")

| Giai đoạn | Test | Kết quả |
|-----------|------|---------|
| Codec CBOR | 13 unit test round-trip mọi tag | **13/13 pass** |
| Parser SurrealQL | 34 test với câu truy vấn thật harvest từ codebase (+ 1.711 câu `latest.surql` parse 0 lỗi) | **34/34 pass** |
| Evaluator | 12 test (bcrypt, flatten, NONE/NULL, duration, cast…) | **12/12 pass** |
| **Integration: SDK `surrealdb` (y hệt app) ↔ dbproxy ↔ PostgreSQL** | CRUD, FETCH, ONLY+`type::record`, bcrypt login, NONE xoá field, datetime round-trip, UNIQUE index, DEFINE DEFAULT, INFO, SHOW CHANGES, LIVE (CREATE/UPDATE/DELETE push), RELATE, GROUP ALL, per-statement ERR | **61/61 pass** |
| Docker | Build image `dbproxy`, boot `postgres + dbproxy` bằng compose, smoke SDK qua `ws://127.0.0.1:8007/rpc` | **5/5 PASS** |
| Tương thích sync-service | Dùng chính `sync-service/src/sync-helpers.js` parse `SHOW CHANGES` của proxy (UPSERT/DELETE/cursor/watermark) | **8/8 PASS** |
| **Full-stack smoke** | Gateway thật: login PIN (bcrypt qua proxy) → `/auth/db-token` → WS relay (JWT) → `authenticate` → query có FETCH → LIVE qua relay | **PASS** |
| Suite cũ — frontend | `npm test` (vitest) | **564/564 pass** (73 file)¹ |
| Suite cũ — sync | `npm run test:sync` | **27/27 pass** |
| Suite cũ — tracking | `npm run test:tracking` | **26 pass, 2 skip**² |

¹ 12 lỗi `spawn UNKNOWN` khi vitest fork worker là lỗi tài nguyên Windows tạm thời của máy chạy test — chạy lẻ từng file đều pass.
² 2 test tự-skip khi chưa đặt `TRACKING_PG_URL` (tính năng mirror tùy chọn, đúng thiết kế cũ).

---

## 7. Cách chạy

```bash
# .env cần có: POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB,
#              SURREAL_USER/SURREAL_PASS (RPC root của dbproxy), GATEWAY_JWT_SECRET
docker compose up -d --build          # postgres + dbproxy + toàn bộ services
docker compose ps                     # postgres healthy, dbproxy listening
```

- Dữ liệu nằm ở volume `postgres-data`. Backup tự động 2 lần/ngày vào `./backups/postgres` (service `backup`, `pg_dump -Fc`).
- Chạy test của proxy: `cd dbproxy && npm test` (integration test tự skip nếu không có PG ở `DB_TEST_PORT`, mặc định 5433).

---

## 8. Giới hạn & ghi nhận kỹ thuật

1. **Execution model:** SELECT đánh giá WHERE/GROUP/SPLIT/FETCH phía JS trên các dòng lấy từ PG (chỉ đẩy xuống PG cho lookup theo PK `id`). Ở quy mô POS hiện tại (vài nghìn dòng/bảng) đủ nhanh; nếu tăng trưởng lớn có thể tăng pushdown SQL mà không đổi giao thức.
2. **Precision số:** JSONB lưu number chuẩn PG `numeric`; vượt 2^53 khi ra JS sẽ mất precision (SDK SurrealDB cũng hoạt động trên double ở tầng này).
3. **`DEFINE INDEX UNIQUE`** được enforce khi ghi, nhưng import/migration không backfill-validate.
4. **`SHOW CHANGES`** mô phỏng changefeed bằng `change_log` (versionstamp = seq pad 20 số, so sánh BigInt được); retention hiện không tự dọn (có thể thêm job dọn theo `updated_at`).
5. **SDK `surrealdb` npm ở frontend được giữ lại** như một wire client — tên package chứa "surreal" nhưng không còn bất kỳ thành phần SurrealDB nào phía server; đổi client này là tối ưu thẩm mỹ tách biệt, không ảnh hưởng DB.
6. Các module `surreal-client.js` trong service giữ nguyên tên file (chỉ là factory tạo SDK client trỏ tới dbproxy).
7. **Rollback** (nếu cần): giữ lại service `surrealdb` trong git history + `./database` chưa bị xóa; data PG có thể xuất lại qua `pg_dump`.

---

## 9. Danh sách file thay đổi / mới

**Mới:**
- `dbproxy/` — toàn bộ service (src, test, Dockerfile, package.json, .dockerignore)
- `migrations/scripts/migrate-surreal-to-pg.cjs` — migration one-shot

**Sửa:**
- `docker-compose.yml` — postgres + dbproxy thay surrealdb; backup pg_dump; re-point services
- `docker-compose.analytics.yml` — mirror trên PG chính
- `.env` / `.env.example` — POSTGRES_* + chú giải SURREAL_* = RPC root của dbproxy
- `.gitignore` — backups/postgres
- `README.md` — tech stack, security note, hướng dẫn migrate datastore cũ

**Không đổi:** toàn bộ `src/` (frontend), code truy vấn của 5 service backend, `migrations/*.surql`.

---

## 10. Kiểm tra live app qua trình duyệt (đã chạy thực tế)

Ngày 2026-11-02 — boot full stack thật và thao tác bằng trình duyệt (browser automation):

```
Vite dev server  → http://localhost:5173  (React app, không đổi code)
Gateway          → http://localhost:3142   (auth + WS relay /rpc)
dbproxy (docker) → ws://127.0.0.1:8007/rpc
PostgreSQL (docker) → 127.0.0.1:5434  (healthy)
```

**Kết quả từng bước trên UI:**

| Bước | Hành động trên màn hình | Kết quả |
|------|------------------------|---------|
| 1 | Mở `http://localhost:5173` | App render màn hình **Login** (PIN pad) |
| 2 | Nhập PIN **1234** → đăng nhập | **Đăng nhập thành công** — bcrypt compare chạy trong dbproxy trên PostgreSQL; header hiện **Synced** (kết nối DB OK) |
| 3 | App yêu cầu **Clock In Required** → bấm CLOCK IN | Vào thẳng hệ thống: Menu, Orders, Summary, Kitchen, Order Display, Delivery, Closing, Inventory, Manage, Reports, Tip Dist., Accounts, HR, Integrations, Settings |
| 4 | Mở **Orders** | **Dữ liệu thật từ PostgreSQL**: Order# 2 — Bàn 11, IN PROGRESS, "Cà phê sữa đá" ×2, Items (2), **₫58.000** |
| 5 | Kiểm tra WRITE trong PG | `time_entry` mới (Clock In), `audit_log` (DEFINE EVENT tự chạy khi login), `sync_terminal`/`sync_number_reservation`/`sync_number_counter` — `change_log` tăng 2.270 → 2.299 row, toàn bộ do UI ghi |

Ảnh chụp màn hình Orders (dữ liệu live từ PostgreSQL): trình duyệt in-app hiển thị order "Bàn 11 — Order# 2 / Delivery — IN PROGRESS — Cà phê sữa đá ×2 — ₫58.000".

> Kết luận: **App chạy được end-to-end trên PostgreSQL** — đọc (orders, users, catalog) lẫn ghi (clock-in, audit, sync handshake) đều qua dbproxy → PostgreSQL, không còn một byte dữ liệu nào đi qua SurrealDB.

---

## 11. Tài khoản đăng nhập (dữ liệu đã migrate)

Đăng nhập màn hình **PIN**: nhập mã PIN rồi bấm nút mũi tên (→). Gateway dùng chính PIN làm mật khẩu (bcrypt trong DB).

| PIN (login = mật khẩu) | Phương thức | Ghi chú |
|------------------------|-------------|---------|
| **1234** | pin | Đã xác minh qua UI + API (HTTP 200, Clock In OK) |
| **0000** | pin | Đã xác minh API (HTTP 200) |
| **5555** | pin | Đã xác minh API (HTTP 200) |
| **8888** | pin | Đã xác minh API (HTTP 200) |
| **9999** | pin | Đã xác minh API (HTTP 200) — DB có 2 user trùng PIN 9999 (bản ghi đầu được dùng) |
| `rider` (tab Form) | form | Mật khẩu dạng bcrypt hash từ data cũ — **không rõ plaintext**; cần reset nếu muốn dùng |

Cách đặt lại mật khẩu cho tài khoản Form (nếu cần): hash mật khẩu mới bằng bcrypt (cost 10) rồi UPDATE vào `data->>'password'` của user tương ứng trong bảng `records`.

Thông tin kết nối PostgreSQL (máy dev, trùng `.env`):

| Thành phần | Giá trị |
|------------|---------|
| Host:port (từ host) | `127.0.0.1:${POSTGRES_HOST_PORT:-5432}` (máy này: **5434**) |
| Database / User / Password | `restaurant_manager` / `restaurant` / `fc3ec04f8907d7032df738bae6951b928d83` |
| RPC root của dbproxy (signin cho services) | `SURREAL_USER` / `SURREAL_PASS` = `restaurant` / `fc3ec04f8907d7032df738bae6951b928d83` |

⚠️ Đổi toàn bộ thông tin trên trước khi deploy thật (xem §7).
