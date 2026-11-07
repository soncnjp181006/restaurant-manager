# MySQL quan hệ hoá — 167 bảng nghiệp vụ thành bảng thật

> **Ngày:** 2026-11-08 · **Nguồn cấu trúc:** `migrations/latest.surql` · **Nguồn dữ liệu:** bảng `records` trong MySQL `restaurant_manager`.
> Bộ sinh/di trú: [`migrations/relational/`](../migrations/relational/). Sơ đồ quan hệ: [`docs/erd/relational.mmd`](erd/relational.mmd).

---

## 1. Kết quả

Trước đây MySQL chỉ có **6 bảng vật lý** (`records` chứa toàn bộ dữ liệu nghiệp vụ dưới dạng cột `JSON`), nên sơ đồ ERD chỉ thấy 6 ô và **không có một quan hệ nào**. Sau khi chuyển:

| Hạng mục | Trước | Sau |
|---|---:|---:|
| Bảng nghiệp vụ vật lý | 1 (`records`) | **167** |
| Bảng con cho mảng (1-n) | 0 | **73** |
| Bảng thuộc tính lồng nhau | 0 | **37** (thêm 130 bảng tạo lúc runtime cho các bảng chưa có) |
| Tổng bảng vật lý trong schema | 6 | **277** (**412** sau khi dbproxy tạo `__attrs` cho mọi bảng) |
| Cột nghiệp vụ có kiểu | 2 (`table_name`, `id`) | **1.370** |
| Khóa ngoại vật lý | **0** | **625** |
| Ràng buộc UNIQUE vật lý | 0 (chỉ enforce trong dbproxy) | **68** |
| Cột kiểu `JSON` | 4 | **0** (1 số cột metadata của dbproxy vẫn giữ JSON — xem §6) |
| Dòng dữ liệu | 6.694 (46 bảng) | **6.694** — xác minh từng ô |

Bảng đích của quan hệ nhiều nhất: `user` (100 cột trỏ tới), `inventory_item` (24), `inventory_location` (22), `inventory_store` (21), `document` (16), `order` (14), `employee` (14), `order_item` (10), `tax` (10).

Ví dụ trực tiếp trên DB mới:

```sql
SELECT o.number, o.status, o.total, u.first_name AS waiter, ft.name AS table_name
FROM `order` o
LEFT JOIN user u        ON u.id = o.user
LEFT JOIN floor_table ft ON ft.id = o.`table`;
```

---

## 2. Cách chạy

```bash
# 1. sinh DDL từ latest.surql + dữ liệu hiện tại
DB_HOST=127.0.0.1 DB_PORT=3307 DB_USER=restaurant DB_PASS=... \
  node migrations/relational/generate.mjs

# 2. tạo database đích, nạp dữ liệu, thêm FK, rồi đối chiếu từng giá trị
DB_PASS=... DB_NAME=restaurant_manager DB_NAME_REL=restaurant_manager_relational \
MYSQL_ROOT_PASSWORD=... node migrations/relational/import.mjs --reset

# 3. chỉ chạy lại phần kiểm tra
DB_PASS=... node migrations/relational/import.mjs --verify-only
```

Hoặc qua npm: `npm run db:relational:generate`, `npm run db:relational:import`, `npm run db:relational:verify`.

`generate.mjs` ghi ra:

- `migrations/relational/001_tables.sql` — 277 `CREATE TABLE` (bảng cha, bảng mảng, bảng thuộc tính), PK/UNIQUE/KEY.
- `migrations/relational/002_foreign_keys.sql` — 385 `ALTER TABLE … ADD CONSTRAINT` cho cột tham chiếu (tổng 625 FK kể cả FK `parent_id`/`ref_id` của bảng con). Tách riêng vì phải nạp dữ liệu trước (quan hệ vòng giữa các bảng).
- `migrations/relational/report.json` — số dòng/cột/FK từng bảng + danh sách ràng buộc bị bỏ qua.
- `docs/erd/relational.mmd` — ERD Mermaid của 385 khóa ngoại giữa các bảng nghiệp vụ.

Database đích mặc định: `restaurant_manager_relational` (đổi bằng `DB_NAME_REL`). Dữ liệu nguồn **không bị sửa**; script chỉ đọc.

---

## 3. Quy tắc ánh xạ

`DEFINE FIELD … TYPE …` quyết định kiểu cột, dữ liệu hiện có quyết định độ dài/cột phát sinh và tính hợp lệ của khóa ngoại.

| Schema SurrealQL | MySQL | Ghi chú |
|---|---|---|
| `id` của record | `id VARCHAR(512) PRIMARY KEY` | Chỉ giữ **key** (`3v9w…`), bỏ tiền tố `order:`. `utf8mb4_bin` để không gộp hoa–thường/dấu. |
| `string` | `VARCHAR(n)` / `TEXT` | `n` theo độ dài dữ liệu thật (≤ 500 để index được), dài hơn → `TEXT`. |
| `int` | `BIGINT` | |
| `float` / `number` | `DOUBLE` | Giữ đúng ngữ nghĩa số thực mà app đang dùng. |
| `bool` | `TINYINT(1)` | |
| `datetime` | `DATETIME(3)` | UTC (connection `timezone:'+00:00'`), giữ mili-giây. |
| `record<X>` | `VARCHAR(512)` + `FOREIGN KEY → X(id)` | Cột luôn cho phép `NULL`, FK `ON DELETE SET NULL ON UPDATE CASCADE`. |
| `array<record<X>>` | bảng con `T__field(parent_id, ord, ref_id)` | `ord` giữ thứ tự mảng; FK `parent_id → T(id) ON DELETE CASCADE` và `ref_id → X(id)`. |
| `array<string>` | bảng con `T__field(parent_id, ord, value_text)` | |
| `array<int/float/bool>` | bảng con với `value_number` / `value_bool` | |
| `object`, `any`, dữ liệu lồng nhau | bảng `T__attrs(parent_id, path, kind, value_text, value_number, value_bool)` | `path` dạng `payload.data.is_locked`, `tags[0]` — **không có cột JSON**. |
| `DEFINE INDEX … UNIQUE` | `UNIQUE KEY` | Bỏ qua nếu dữ liệu hiện tại đang trùng. |
| `DEFINE INDEX` (thường) | `KEY` | Bỏ qua nếu cột là `TEXT`/quá 500 ký tự. |

Thêm hai cột metadata giữ nguyên vai trò của `records` cũ: `row_created_at`, `row_updated_at` (`TIMESTAMP(3)`).

**Chỉ `id` là `NOT NULL`.** Mọi cột nghiệp vụ đều cho phép `NULL` (trừ cột hệ thống của bảng con: `parent_id`, `ord`, `path`, `kind`). Lý do: app ghi record theo kiểu document — payload từng phần (`MERGE_RECORD`), và link chuẩn nằm ở mảng của bảng cha (`order.payments`), client cố ý bỏ qua cột back-reference ở bảng con. Đặt `NOT NULL` theo dữ liệu mẫu làm hỏng đúng những đường ghi đó (`Field 'order' doesn't have a default value`, `Field 'created_at' …`). Tính toàn vẹn vẫn do `PRIMARY KEY` / `FOREIGN KEY` / `UNIQUE KEY` đảm bảo.

**Chiều ngược của quan hệ được tự điền:** khi ghi mảng `T.field` trỏ tới bảng con `C`, nếu `C` có cột cùng tên bảng cha và trỏ về `T` (ví dụ `order_payment.order`, `order_item.order`) thì `RelationalStore` set cột đó bằng `parent_id` nếu đang `NULL`. Nhờ vậy cả hai chiều đều truy vấn được bằng SQL thuần:

```sql
SELECT * FROM order_payment WHERE `order` = 'ifQmkjFcCR1fXW1F126kr';
SELECT * FROM order__payments WHERE parent_id = 'ifQmkjFcCR1fXW1F126kr';
```

Quy ước đặt tên:

- Bảng con: `<bảng>__<field>` (rút gọn + hash 8 ký tự nếu vượt 64 ký tự của MySQL).
- Bảng thuộc tính: `<bảng>__attrs`.
- FK: `<bảng>_<cột>_fk`; FK của bảng con: `<bảng_con>_parent_fk` / `_ref_fk`.
- Tên bảng/cột trùng từ khóa (`order`, `table`, `group`, `key`, `change`, `in`, `out`) được quote bằng backtick.

Khóa ngoại chỉ được tạo khi **mọi giá trị hiện có đều phân giải được** — không có FK "trang trí". Composite index dùng prefix (`col(255)`) để không vượt giới hạn 3.072 byte của InnoDB.

---

## 4. Kiểm chứng

`import.mjs` không chỉ đếm dòng. Với **từng record** nó dựng lại object từ bảng cha + bảng con + bảng thuộc tính rồi so sánh sâu với JSON nguồn (datetime so theo mốc thời gian, số theo giá trị):

```
target restaurant_manager_relational: 167 tables, 495 foreign keys
verified 6694 records (values, arrays, nested attributes)
OK — relational copy matches the JSON store value for value
```

**Control âm (chứng minh không "xanh giả"):** sửa `menu_item.name` của một dòng thành `CORRUPTED` rồi chạy `--verify-only`:

```
1 mismatch(es):
  - menu_item:glmg8ucrcae5nd5rslhd.name: "Trà đào" != "CORRUPTED"
```

Sau đó nạp lại bằng `--reset` → về `OK`. Ngoài ra script kiểm tra 0 tham chiếu mồ côi trên mọi cột có FK.

Kiểm tra trực tiếp trên MySQL:

```sql
-- 412 bảng (277 trong DDL + __attrs tạo lúc runtime), 625 FK, 0 cột JSON nghiệp vụ
SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='restaurant_manager_relational';
SELECT COUNT(*) FROM information_schema.table_constraints
 WHERE table_schema='restaurant_manager_relational' AND constraint_type='FOREIGN KEY';
SELECT COUNT(*) FROM information_schema.columns
 WHERE table_schema='restaurant_manager_relational' AND data_type='json';
```

---

## 5. Ngoại lệ đã ghi nhận (7)

Sinh schema ghi các mục này vào `report.json` và in ra khi chạy:

| Mục | Lý do | Xử lý |
|---|---|---|
| `employee.user` (4 giá trị) | 11 nhân viên nhưng chỉ 7 user tồn tại; 4 `employee.user` trỏ tới user đã xoá | Không tạo FK (dữ liệu giữ nguyên), cột vẫn có index |
| `order.discount`, `order.tax` | Schema khai báo `record<…>` nhưng dữ liệu cũ ghi **số** (`tax: 0`) | Lưu ở `order__attrs`, không bịa FK |
| `order_item_kitchen.stage` | Khai báo `record<workflow_stage>`, dữ liệu ghi chuỗi trạng thái | `order_item_kitchen__attrs` |
| `order_payment.payment_type` | Khai báo record, dữ liệu ghi mã dạng chuỗi | `order_payment__attrs` |
| `sync_event.event_id` UNIQUE | Dữ liệu đang có event_id trùng (bảng SCHEMALESS) | Không tạo UNIQUE; cột vẫn có |
| `integration_provider.id` | Field `id` trùng khóa chính | Dùng luôn PK `id` |
| `sync_cursor`, `sync_conflict`, `sync_cloud_cursor`, `sync_catalog_down_cursor`, `auth_permission`, `integration_provider_secret`, … | SCHEMALESS, không có `DEFINE FIELD` và chưa có dòng nào để suy kiểu | Chỉ có `id` + 2 cột metadata; ghi mới sẽ vào `T__attrs` |

---

## 6. Giới hạn — đọc kỹ

1. **Cutover đã bật** (`DB_LAYOUT=relational`): `dbproxy` đọc/ghi thẳng các bảng này qua `dbproxy/src/store.relational.mjs`; layout JSON cũ vẫn còn để rollback (`DB_LAYOUT=json`).
2. **Schema là ảnh chụp theo dữ liệu.** Cột phát sinh từ dữ liệu của bảng SCHEMALESS sẽ thay đổi nếu dữ liệu đổi; chạy lại `generate.mjs` sau mỗi migration mới rồi so `001_tables.sql`.
3. **`_schema_migration`, `change_log`, `field_kinds`, `unique_indexes`, `field_defaults`, `event_defs`** vẫn nằm ở DB cũ: chúng là metadata/công cụ của dbproxy (AST event, watermark sync), không phải bảng nghiệp vụ. `change_log.data` vẫn là JSON vì giao thức `SHOW CHANGES`/LIVE cần before/after image.
4. **Xóa dữ liệu giờ bị chặn bởi FK** (`RESTRICT` với tham chiếu bắt buộc), khác hành vi cũ (xóa tự do, để lại tham chiếu mồ côi). Đây là chủ ý của mô hình quan hệ; app cần soft-delete hoặc xóa theo thứ tự khi chuyển sang dùng các bảng này.
5. Collation `utf8mb4_bin` là bắt buộc — `order:2` và `order:2` khác `Order:2`; đổi sang `_ci` sẽ gộp khóa.

---

## 7. Cutover (đã thực hiện)

1. `dbproxy/src/store.relational.mjs` — `RelationalStore` cùng interface với `MySqlStore` (`getRecords/scanTable/scanTables/writeRecord/updateRecord/deleteRecord/bulkImport/…`), tự đọc `INFORMATION_SCHEMA` lúc khởi động và tạo bảng `__attrs` cho mọi bảng nghiệp vụ (DDL một lần, không nằm trong transaction của request).
2. `docker-compose.yml`: `DB_NAME=${MYSQL_DB_REL:-…}`, `DB_LAYOUT=${DB_LAYOUT:-json}`; `.env` đặt `DB_LAYOUT=relational`. Không đặt thì chạy layout JSON cũ.
3. Kiểm thử live (2026-11-08):
   - đăng nhập PIN qua gateway → 200; `audit_log` ghi cột thật;
   - POS đọc `order`/`order_item`/`menu_item`/`setting`/`inventory_item`/`account_journal_entry`, `count() GROUP ALL`, `FETCH` đều đúng;
   - thanh toán một đơn trong UI → `order.status='Paid'`, `order_payment` có dòng mới, `order__payments` có link, `change_log` tăng;
   - sync-service đẩy outbox → `sync_accepted_operation`/`sync_event` ghi vào bảng riêng, không còn `APPLY_ERROR`;
   - tracking: ghi mới vào bảng `tracking` sau khi đổi `tracking.user_agent` sang `TEXT`.
4. Bộ test: dbproxy **71/71**, `npm run test:sync` **27/27**; `import.mjs --reset` nạp lại 6.694 record vào database trắng và xác minh từng giá trị.

### Còn lại

- `change_log`, `field_kinds`, `unique_indexes`, `field_defaults`, `event_defs`, `_schema_migration` là metadata của dbproxy nên vẫn giữ nguyên dạng (before/after JSON cần cho `SHOW CHANGES`/LIVE); chúng không phải bảng nghiệp vụ.
- Bảng SCHEMALESS chưa có dòng nào (`sync_conflict`, `sync_cursor`, `integration_provider_secret`, …) chỉ có `id`; field mới ghi vào `T__attrs` — muốn thành cột thật thì chạy lại `generate.mjs` sau khi bảng có dữ liệu.
- `records` (JSON) vẫn còn nguyên làm bản sao lưu/rollback; chỉ đọc. Có thể bỏ sau khi chạy relational ổn định.
