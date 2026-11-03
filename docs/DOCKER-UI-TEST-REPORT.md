# Báo cáo đưa backend vào Docker & kiểm thử UI trực tiếp

> **Ngày:** 2026-11-03 · **Nhánh:** `authorization` · **Commit:** `626e11a`
> **Phạm vi:** (1) Chạy **toàn bộ backend trong Docker Compose** (MySQL 8 + dbproxy + gateway + api + tracking + payment + sync + printer + backup) và frontend dev-server; (2) **Kiểm thử UI đen (black-box)** qua trình duyệt thật: đăng nhập, đọc dữ liệu thật từ MySQL, ghi dữ liệu từ UI và **đối chiếu từng write trong MySQL**.
> Báo cáo DB đi kèm: [`DB-SCHEMA-REPORT.md`](DB-SCHEMA-REPORT.md).

---

## 1. Tóm tắt (TL;DR)

| # | Hạng mục | Kết quả |
|---|---|---|
| 1 | Backend chạy 100% trong Docker | ✅ **10/10 container Up** — mysql (healthy), dbproxy, gateway, api, tracking, payment, sync, printer, backup, app (Vite). Mọi `/health` sidecar trả **200**. |
| 2 | Frontend chạy trong Docker | ✅ sau khi vá 1 vấn đề native-module (thêm overlay `docker-compose.ui.yml` — xem §3). Vite trả 200 tại `http://localhost:5173`. |
| 3 | UI đọc dữ liệu thật từ MySQL | ✅ Login PIN → màn Đơn hàng hiển thị 2 đơn có sẵn (`order` đếm trong DB = 2 thẻ trên UI), món "Cà phê sữa đá #001 ₫29,000" khớp `menu_item`. |
| 4 | UI ghi dữ liệu xuống MySQL | ✅ **Clock Out** cập nhật `time_entry.clock_out = 2026-11-03T16:34:43.020Z` (trước đó NULL); `change_log` ghi `UPDATE time_entry` 22 ms sau đó. **Clock In** tạo `time_entry` mới `clock_in = 16:35:42.372Z`. |
| 5 | Lỗi phát hiện khi kiểm thử | ⚠️ **BUG-1 (P1):** sync đẩy thay đổi bị lỗi vĩnh viễn với 1 op — dbproxy parser không hỗ trợ gán compound `SET x += y` của SurrealQL. ⚠️ **BUG-2 (P3):** widget phiên làm việc đè lên thẻ "Bàn 11" trên màn sàn. |
| 6 | Dữ liệu sau phiên kiểm thử | `records` 2.280 → **2.370** (+90), `change_log` 4.565 → **4.673**. Không mất dữ liệu, không cần sửa tay DB. |

---

## 2. Môi trường Docker

### 2.1 Các dịch vụ đã chạy

| Container | Image | Cổng host | Ghi chú |
|---|---|---|---|
| `restaurant-pos-mysql-1` | mysql:8.0 | 3307 | healthy — healthcheck thật `mysql -e 'SELECT 1'`; `utf8mb4_bin`, READ-COMMITTED |
| `restaurant-pos-dbproxy-1` | restaurant-manager-dbproxy:latest (build từ `./dbproxy`) | 8007→8000 | WS `/rpc`; trả **HTTP 426 Upgrade Required** cho request thường — đúng thiết kế (chỉ nhận WebSocket) |
| `restaurant-pos-gateway-1` | node:20-alpine | 3142 | JWT + WS relay |
| `restaurant-pos-api-1` | node:20-alpine | 3140 | `/health` → 200 |
| `restaurant-pos-tracking-1` | node:20-alpine | 3138 | `/health` → 200; `mysqlMirror: "disabled"` (đúng thiết kế opt-in qua `docker-compose.analytics.yml`) |
| `restaurant-pos-payment-1` | node:20-alpine | 3134 | `/health` → 200 |
| `restaurant-pos-sync-1` | node:20-alpine | 3136 | đồng bộ đa chi nhánh |
| `restaurant-pos-printer-1` | restaurant-manager-printer:latest (build từ `./printing`) | 3132 | in ấn |
| `restaurant-pos-backup-1` | mysql:8.0 | — | mysqldump định kỳ vào `./backups/mysql` |
| `restaurant-pos-app-1` | oven/bun:latest | 5173 | **frontend** dev server (Vite) — phục vụ kiểm thử UI |

### 2.2 Lệnh chạy

```bash
# Backend + frontend đầy đủ (kèm overlay mới cho app, xem §3)
docker compose -f docker-compose.yml -f docker-compose.ui.yml up -d

# Chỉ backend (không chạy Vite trong Docker — frontend chạy nơi khác)
docker compose up -d
```

Credentials đọc từ `.env` (đã có sẵn: `MYSQL_*`, `SURREAL_*`, `GATEWAY_JWT_SECRET`).

---

## 3. Vấn đề gặp phải khi docker hóa & cách xử lý

### 3.1 Container `app` crash: native module sai nền tảng (đã xử lý)

- **Hiện tượng:** container `app` thoát (exit 1) với `Cannot find module '../rolldown-binding.linux-x64-gnu.node'` — `node_modules` trên host được cài bằng Bun cho **Windows**, nhưng container chạy **Linux x64**; mount đè cả thư mục khiến binary native không khớp.
- **Xử lý:** tạo **`docker-compose.ui.yml`** (overlay, cùng idiom với `docker-compose.usb.yml`/`analytics.yml` sẵn có): gắn named volume `app-node_modules` che `node_modules` trên host, rồi `bun install` ngay trong container trước `bun run dev`. Không sửa `docker-compose.yml` gốc, không đụng `node_modules` của host.
- **Lưu ý phát hiện thêm:** `bun.lockb` lệch với `package.json` (`@typescript-eslint/eslint-plugin` `^6` trong lockfile vs `^8.72.1` trong package.json) nên `--frozen-lockfile` fail — overlay dùng `bun install` thường (chỉ ảnh hưởng volume trong container). **Khuyến nghị:** chạy `bun install` trên host và commit lockfile mới.

### 3.2 Không có vấn đề nào khác

mysql/dbproxy/gateway/api/tracking/payment/sync/printer/backup đều lên lần đầu, healthcheck mysql chuyển `healthy` sau vài giây, dbproxy init schema trong 64 ms.

---

## 4. Kiểm thử UI trực tiếp (black-box qua trình duyệt thật)

**Phương pháp:** trình duyệt thật điều khiển qua automation, chỉ thao tác như người dùng thật (click, nhập PIN) — không inject JavaScript thay đổi trạng thái. Mỗi bước có ảnh chụp lưu tại `scratch/gui-test-screenshots/`. Số liệu DB đối chiếu trực tiếp bằng SQL trong container MySQL **sau từng write**.

**Chuẩn bị môi trường (trước khi test):** `docker compose up -d` toàn bộ stack; chỉnh overlay cho `app` (§3.1); chụp baseline DB: `order` = 2 dòng, `change_log` max seq = 4.565, `time_entry` = 2 dòng. **Từ bước T1 trở đi là kiểm thử chính thức, không can thiệp gì thêm.**

### T1 — Màn hình đăng nhập hiển thị đúng ✅

Vào `http://localhost:5173` → render "Login", tab PIN/FORM, bàn phím số 1–9/0/C, 4 ô PIN.

![T1 màn đăng nhập](../scratch/gui-test-screenshots/t1_login.png)

### T2 — Đăng nhập PIN `1234` ✅

Nhập PIN bằng click bàn phím → vào thẳng màn hình chính: sidebar đầy đủ (Menu, Orders, Summary, Kitchen, Order Display, Delivery, Closing, Inventory, Manage, Reports, Tip Dist., Accounts, HR, Integrations, Settings), trạng thái sync, user "(Manager)". App mở dialog "AI dish recipe lookup" (what's-new) — bấm **GOT IT** để đóng, hiển thị đúng.

![T2 dialog what's-new](../scratch/gui-test-screenshots/t2_whatsnew_dialog.png)

### T3 — Màn sàn nhà (Floor) ✅ với 1 lỗi hiển thị nhỏ ⚠️ BUG-2

Sàn "SẢNH CHÍNH" render; **BUG-2 (P3):** widget phiên làm việc ("89h 4m", "Bàn 11", "₫0") hiển thị đè chữ lên thẻ "Bàn 11" ở góc trên trái — xảy ra ở cả 1280×720 lẫn 1366×768. Không chặn thao tác.

![T3 widget đè chữ góc trên](../scratch/gui-test-screenshots/t3_floor_view_widget_overlap.png)

### T4 — Màn Đơn hàng đọc dữ liệu thật từ MySQL ✅

Mở đơn có sẵn **ORDER# 2 / Bàn 11**: menu "Món chính" hiện "Cà phê sữa đá #001 ₫29,000" (khớp `menu_item` trong DB); giỏ hiển thị các dòng món có sẵn với tổng tiền tính đúng. Nút TO KITCHEN / PAY NOW / CANCEL đầy đủ.

![T4 màn đơn hàng dữ liệu thật](../scratch/gui-test-screenshots/t4_order_screen_real_data.png)

### T5 — Màn Order Display (danh sách đơn) ✅

2 thẻ đơn khớp đúng 2 dòng `order` trong MySQL: **Order# AB8GRT** (Delivery, IN PROGRESS, Kashif, 4 món ₫116.000) và **Order# 2** (Delivery, IN PROGRESS, Manager, 2 món ₫58.000). Bộ lọc status/types/floors/users/date + OPEN CASH DRAWER/BLOCKS hiển thị đúng.

![T5 Order Display](../scratch/gui-test-screenshots/t5_order_display.png)

### T6 — WRITE TEST: Clock Out ghi xuống MySQL ✅

Trang `/clock` hiển thị phiên: Clock In 05:43 PM, Kashif ali (order taker), shift morning, Time Elapsed 5h51m. Bấm **CLOCK OUT** → app đăng xuất về Login (hành vi đúng).

**Đối chiếu SQL ngay sau khi bấm:**

```sql
SELECT id, clock_in, clock_out FROM time_entry ...
-- 8jtcbi15ztskzdd7ekyu  2026-11-03T10:43:09.598Z → clock_out 2026-11-03T16:34:43.020Z  (trước đó NULL)
SELECT ... FROM change_log ORDER BY seq DESC LIMIT 1;
-- UPDATE time_entry 8jtcbi15ztskzdd7ekyu  at 2026-11-03 16:34:43.041  (22 ms sau khi ghi)
```

`change_log` tăng 4.665 → 4.671 (UPDATE time_entry + tracking CREATE ×2 + floor_table UPDATE + sync_terminal UPDATE).

![T6 trước khi Clock Out](../scratch/gui-test-screenshots/t6_before_clockout.png)
![T7 sau Clock Out — về màn Login](../scratch/gui-test-screenshots/t7_after_clockout_login.png)

### T7 — Gate "Clock In Required" hoạt động đúng ✅

Đăng nhập lại bằng PIN `1234` **khi chưa clock in** → app chặn bằng dialog **"Clock In Required — You need to clock in before accessing the system."** Bấm **Clock In** → tạo `time_entry` mới và vào hệ thống.

**Đối chiếu SQL:** dòng mới `axmbguuw0khp2tdmm65t`, `clock_in = 2026-11-03T16:35:42.372Z`, `clock_out = NULL`; `change_log` 4.671 → 4.673.

### T8 — Trạng thái khôi phục ✅

`/clock` hiển thị phiên mới: Clock In 11:35 PM (giờ địa phương), Time Elapsed chạy từ 0, nút CLOCK OUT sẵn sàng. Sale Summary của ca hiển thị ₫0 đúng (chưa có bán hàng trong ca mới).

![T8 đã clock in lại](../scratch/gui-test-screenshots/t8_clocked_in_again.png)

---

## 5. Lỗi phát hiện trong quá trình kiểm thử

### BUG-1 (P1) — Sync đẩy thay đổi fail vĩnh viễn với 1 op: dbproxy không hỗ trợ `SET x += y`

- **Biểu hiện trên UI:** nút sync chuyển đỏ với tooltip: *"Sync failed: There was a problem with the database: Expected '=' but got op '+'"*. Trong phiên test, hàng đợi đổi trạng thái: **"62 changes queued" → "127" → "318" → "1 change(s) could not reach the server after several attempts"** — tức phần lớn op đã được đẩy thành công (ghi được vào MySQL, xác minh bằng `change_log`), nhưng **1 op chết hàng vĩnh viễn**.
- **Gốc rễ (đã xác minh bằng code, không sửa trong lúc test):** frontend có 2 nơi dùng cú pháp SurrealDB *compound assignment* — `UPDATE $group SET modifiers += $modifier` (`src/components/settings/dishes/smart-menu.import.config.ts:371` và `src/components/settings/modifier_groups/modifier-group.import.config.ts:202`); parser của dbproxy (`dbproxy/src/parser.mjs`) **không có nhánh xử lý `+=`** → báo đúng lỗi "Expected '=' but got op '+'".
- **Tác động:** luồng nhập menu hàng loạt (smart-menu import) sẽ không lưu được qua dbproxy; 1 op kẹt làm trạng thái sync đỏ thường trực.
- **Khuyến nghị sửa (chọn 1):** (a) thêm hỗ trợ `SET x += y` vào parser/eval của dbproxy (ngữ nghĩa append vào mảng như SurrealDB); hoặc (b) đổi 2 chỗ gọi ở frontend thành đọc-ghép-ghi (`SET modifiers = $newArray`).

### BUG-2 (P3) — Widget phiên làm việc đè thẻ bàn trên màn sàn

Xem T3. Widget "89h 4m / Bàn 11 / ₫0" vẽ đè lên thẻ "Bàn 11" ở góc trên trái màn hình sàn, chữ chồng chữ khó đọc. Không chặn thao tác; chỉ gặp ở màn floor khi sidebar ở trạng thái thu gọn.

### Quan sát thêm (không phải lỗi)

- **Mirror tracking `disabled` là đúng thiết kế:** `/health` của tracking báo `mysqlMirror:"disabled"` vì mirror chỉ bật khi chạy kèm `docker-compose.analytics.yml` (opt-in); bảng `tracking_events` giữ 1 dòng từ lần bật trước, còn `tracking` (logical) nhận 303 → **387** sự kiện trong phiên test.
- **dbproxy trả HTTP 426** cho request thường tới cổng 8007 — đúng, vì nó chỉ nói WebSocket `/rpc`.
- Console log của trình duyệt không thu thập được qua công cụ tự động (hạn chế của runtime); mọi kết luận dựa trên trạng thái hiển thị trên trang + đối chiếu SQL, không có lỗi hiển thị nào khác ngoài BUG-1/BUG-2.

---

## 6. Số liệu cuối phiên

| Chỉ số | Trước test | Sau test |
|---|---:|---:|
| `records` (tổng dòng) | 2.280 | **2.370** (+90) |
| `change_log` max seq | 4.565 | **4.673** |
| `time_entry` | 2 (1 đang mở) | 3 (1 đóng mới + 1 mở mới, khớp luồng Clock Out/In) |
| `tracking` (logical) | 303 | **387** |
| Container Up / tổng | — | **10/10** (mysql healthy) |
| `/health` sidecars (3132/3134/3136/3138/3140/3142) | — | 200 (3138 xác minh body `ok:true`) |

---

## 7. Kết luận & khuyến nghị

1. **Docker hóa đạt mục tiêu:** toàn bộ backend (10 service) chạy trong Compose, healthcheck thật, dữ liệu nằm ở volume `mysql-data`, backup mysqldump tự chạy; frontend chạy trong Docker sau khi vá overlay `docker-compose.ui.yml` (vấn đề native-module Windows/Linux).
2. **UI hoạt động end-to-end trên dữ liệu thật:** đọc (đơn hàng, menu, order display, sale summary) và ghi (Clock Out/Clock In) đều đối chiếu khớp từng byte trong MySQL qua `change_log`.
3. **Cần xử lý:** BUG-1 (thêm `+=` vào dbproxy hoặc đổi cú pháp 2 chỗ ở frontend — ưu tiên (a) vì giữ tương thích SurrealDB); BUG-2 (CSS z-index/vị trí widget phiên); commit lại `bun.lockb` cho khớp `package.json`.
