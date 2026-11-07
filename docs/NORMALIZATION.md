# Chuẩn hóa lược đồ quan hệ — 1NF · 2NF · 3NF · BCNF · 4NF/5NF

> **Ngày:** 2026-11-08 · **Đối tượng:** lược đồ quan hệ MySQL `restaurant_manager_relational` (277 bảng trong DDL — [`migrations/relational/001_tables.sql`](../migrations/relational/001_tables.sql), 412 bảng trên DB live sau khi dbproxy tạo `__attrs` runtime).
> Phân tích dựa trên **DDL thật + dữ liệu thật** (mỗi kết luận quan trọng đều kèm truy vấn kiểm chứng ở §8). Lược đồ & quy tắc ánh xạ: [`docs/RELATIONAL-MYSQL.md`](RELATIONAL-MYSQL.md). Sơ đồ: [`docs/erd/relational-full.html`](erd/relational-full.html).

---

## 1. Phương pháp

Chuẩn hóa kiểm tra **phụ thuộc hàm** (FD `X → Y`: giá trị của X xác định duy nhất giá trị của Y). Với lược đồ sinh tự động từ document store, việc lập FD khả thi vì cấu trúc chỉ có 4 dạng bảng — mỗi dạng có một tập FD hiển nhiên. Quy trình:

1. Phân lớp toàn bộ 277 bảng theo khóa chính (script đếm từ `001_tables.sql`).
2. Viết tập FD cho từng lớp từ quy tắc ánh xạ (§3 của `RELATIONAL-MYSQL.md`).
3. Đối chiếu định nghĩa từng chuẩn: 1NF → 2NF → 3NF → BCNF → 4NF/5NF.
4. Quét DDL **tự động** tìm ứng viên vi phạm 3NF (cặp cột `x` + `x_id`, cột `*_amount/*_total/payable`), rồi **kiểm chứng trên DB live** từng ứng viên — không dán nhãn vi phạm theo suy đoán.

## 2. Phân lớp bảng & tập phụ thuộc hàm

| Lớp | Định dạng | Số lượng (DDL) | Số lượng (live) | FD |
|---|---|---:|---:|---|
| A — bảng cha | PK `id` | 167 | 167 | `id → mọi cột` |
| B — bảng con mảng | PK `(parent_id, ord)` | 73 | 73 | `(parent_id, ord) → ref_id` hoặc `→ value_*` |
| C — bảng thuộc tính EAV | PK `(parent_id, path)` | 37 | 167 | `(parent_id, path) → kind, value_*` |
| D — metadata dbproxy | khóa riêng | — (ở DB cũ) | 5 | ngoài phạm vi nghiệp vụ |

Live = 412 bảng: 240 nghiệp vụ chính (A+B) + 167 bảng `__attrs` (37 trong DDL + 130 dbproxy tạo runtime cho bảng chưa có mảng lúc chuyển) + 5 bảng metadata (`change_log`, `event_defs`, `field_defaults`, `field_kinds`, `unique_indexes` — có cột JSON, xem §3).

Lưu ý về UNIQUE đơn cột (vd `employee.employee_number`): cột được phép NULL nên không tạo khóa ứng viên thực sự (nhiều dòng NULL là hợp lệ). **`id` là khóa duy nhất của mọi bảng lớp A** — mọi UNIQUE khác chỉ là ràng buộc giá trị.

## 3. 1NF — giá trị nguyên tử — **ĐẠT**

Định nghĩa: mọi giá trị cột đều nguyên tử, không lặp nhóm trong một ô.

- **Mảng bị tách bảng con**: `order.payments` → `order__payments(parent_id, ord, ref_id)`; mỗi phần tử một dòng, `ord` giữ thứ tự. 73 bảng con lớp B.
- **Đối tượng lồng nhau bị tách bảng EAV**: `payload.data.is_locked` → `order__attrs(parent_id, path, kind, value_text|value_number|value_bool)`. 37 bảng lớp C trong DDL.
- **Kiểm chứng live — 0 cột JSON nghiệp vụ:**

```sql
SELECT COUNT(*) FROM information_schema.columns
 WHERE table_schema='restaurant_manager_relational' AND data_type='json';   -- 5
-- 5 cột đó toàn bộ thuộc metadata dbproxy:
--   change_log.data, event_defs.when_ast, event_defs.then_statements,
--   field_defaults.expr, unique_indexes.fields
```

Đối chiếu với trạng thái trước khi chuyển: `records` là 1 bảng JSON chứa toàn bộ 6.694 record nghiệp vụ → nay 0 cột JSON nghiệp vụ trên 412 bảng. `change_log.data` giữ JSON **có chủ ý** vì giao thức `SHOW CHANGES`/LIVE của dbproxy cần before/after image nguyên khối — đây là bảng công cụ, không phải bảng nghiệp vụ.

**Kết luận: 412/412 bảng đạt 1NF** (metadata được miễn và đã ghi lý do).

## 4. 2NF — không phụ thuộc một phần khóa — **ĐẠT**

Định nghĩa (áp dụng cho bảng khóa phức hợp): không cột phi khóa nào phụ thuộc vào **một phần** của khóa. Bảng khóa đơn (`id`) đạt 2NF tự động.

Cả **110 bảng khóa phức hợp** (73 lớp B + 37 lớp C) đều thuộc một trong hai dạng:

| Dạng | Khóa | Cột phi khóa nghiệp vụ | Phụ thuộc một phần? |
|---|---|---|---|
| Bảng con mảng | `(parent_id, ord)` | đúng 1 cột giá trị (`ref_id` / `value_text` / `value_number` / `value_bool`) | Không — cột giá trị chỉ xác định được khi biết cả vị trí `ord` trong mảng |
| Bảng EAV | `(parent_id, path)` | `kind` + 3 cột giá trị | Không — cùng một `parent_id` có nhiều `path`, giá trị chỉ ứng với từng `path` |

Không có bảng nào kiểu "bảng mảng + cột mô tả của cha" (đó chính là dạng gây vi phạm 2NF điển hình) vì generator chỉ phát sinh bảng con cho đúng một trường mảng.

**Kết luận: 110/110 bảng khóa phức hợp đạt 2NF; 167 bảng khóa đơn đạt 2NF hiển nhiên.**

## 5. 3NF — không phụ thuộc bắc cầu — **ĐẠT về khóa; có 2 nhóm ngoại lệ có kiểm soát**

Định nghĩa: mọi cột phi khóa phải phụ thuộc trực tiếp vào khóa, không qua cột phi khóa khác (`id → a → b` là vi phạm).

### 5a. Quét tự động toàn bộ 277 bảng

Script quét DDL theo hai heuristic: (1) cặp `x` (text) + `x_id` (FK) trong cùng bảng — dấu hiệu chép tên kèm khóa; (2) cột `*_amount`, `*_total`, `total_*`, `payable`, `subtotal` — dấu hiệu giá trị tính toán. Kết quả thô: **1 cặp name/id, 22 cột tiền/tổng**. Sau khi rà từng cột trên dữ liệu live, chia hai nhóm:

### 5b. Nhóm A — snapshot tính toán lúc ghi (20 cột / 12 bảng) — **giữ, có chủ ý**

Đây là các cột "chốt sổ" lưu giá trị **tại thời điểm sự kiện** để lịch sử tài chính không đổi khi dữ liệu nguồn đổi. Ví dụ có kiểm chứng live:

```sql
-- giá bán tại thời điểm bán được chụp từ menu_item:
SELECT oi.price AS order_item_price, mi.price AS menu_price_now
FROM order_item oi LEFT JOIN menu_item mi ON mi.id = oi.item;   -- hiện bằng nhau;
-- khi menu đổi giá, order_item.price GIỮ NGUYÊN giá đã bán — đó là mục đích
```

| Bảng | Cột snapshot | Được tính từ |
|---|---|---|
| `order` | `discount_amount`, `tax_amount`, `service_charge_amount` | rate × tạm tính / Σ `order_item.tax` |
| `order_item` | `price`, `cost` | `menu_item.price/cost` **lúc bán** |
| `order_payment` | `payable` | tổng còn phải trả của order (live: = `amount` ở cả 5 dòng) |
| `order_discount` | `base_amount`, `applied_amount` | tạm tính / số giảm lúc áp dụng |
| `coupon_redemption` | `discount_amount` | coupon × order lúc đổi |
| `day_closing` | `total_cash`, `total_other_payments`, `net_amount` | Σ thanh toán trong ca (live: 102.900 = 102.900 + 0) |
| `inventory_ledger` | `total_cost` | quantity × unit_cost |
| `inventory_purchase` | `tax_amount` | Σ dòng |
| `inventory_purchase_item` | `total_inventory_cost` | quantity × price |
| `production_batch` | `total_input_cost`, `total_output_cost` | Σ dòng vào/ra |
| `production_batch_input` | `total_cost` | quantity × cost |
| `buffet_consumption_log` | `total_consumed`, `total_food_cost` | Σ tiêu thụ |

Về lý thuyết đây là phụ thuộc bắc cầu (`id → đơn hàng → tổng tiền`), nhưng **chuẩn hóa cứng những cột này sẽ phá tính đúng đắn của sổ kế toán** (sửa `menu_item.price` hôm sau không được phép đổi tiền đã thu hôm qua). Thực hành chuẩn cho ledger/POS là "3NF + snapshot có kiểm soát" — đúng như đã làm.

*(Lưu ý: `coupon.min_order_amount`, `discount.min_order_amount`, `role_discount_policy.max_fixed_amount` cũng dính heuristic tiền/tổng nhưng là **tham số chính sách đầu vào**, không dẫn xuất — không phải vi phạm.)*

### 5c. Nhóm B — trùng lặp thật (2 cụm) — **đã ghi chính sách / có phương án chuẩn hóa**

**B1. Tên chép kèm khóa trong `order_item`:**

```sql
SELECT category_id, COUNT(*) n, COUNT(DISTINCT category) ten_khac, GROUP_CONCAT(DISTINCT category)
FROM order_item GROUP BY category_id;
-- 9 dòng, 1 category_id  ->  đúng 1 tên: 'Đồ uống'  =>  FD: id -> category_id -> category
```

`order_item.category` (tên) và `order_item.menu` (tên menu) là snapshot tên hiển thị chụp cùng lúc với `category_id`/`item` — cùng bản chất nhóm A (lịch sử bán không đổi theo rename danh mục). Nếu muốn 3NF nghiêm ngặt: bỏ 2 cột text, JOIN qua `category_id` — đánh đổi là hóa đơn cũ đổi theo khi danh mục được đổi tên. **Quyết định hiện tại: giữ như snapshot** (nhất quán với nhóm A); cặp này được đánh dấu ở đây để ai đọc lược đồ không tưởng nhầm là quên chuẩn hóa.

**B2. Hai biểu diễn song song của cùng một giá trị** — `inventory_purchase_order_item` và `menu_item_recipe` (và các bảng nhập kho cùng mẫu) có `price/quantity` (đã quy đổi) cạnh `entered_price/entered_quantity/entered_uom` (đúng như người dùng nhập):

```
quantity = entered_quantity × hệ số quy đổi của entered_uom
```

FD tiềm tàng: `entered_quantity, entered_uom → quantity` (qua bảng hệ số UoM mà hiện **chưa có bảng nào lưu**). Vì hệ số không nằm trong lược đồ nên 3 cột `entered_*` hiện là fact độc lập — chưa vi phạm 3NF theo nghĩa hẹp, nhưng **dư thừa khi có bảng quy đổi**. Phương án nếu chuẩn hóa sâu: tạo `inventory_uom_conversion(from_uom, to_uom, factor)`, giữ `entered_*` làm nguồn sự thật, tính `quantity` khi truy vấn.

**Kết luận 3NF:** mọi FD non-trivial từ khóa trực tiếp ở 240 bảng nghiệp vụ, trừ 20 cột nhóm A (snapshot có chủ ý, liệt kê đủ) và 2 cụm nhóm B (đã ghi chính sách). **Không có vi phạm "bẫy" nào — không cột nào dư thừa mà không được biện luận.**

## 6. BCNF — mọi determinant là siêu khóa — **ĐẠT** (kèm 1 lưu ý thiết kế)

- Lớp A: determinant duy nhất là `id` (khóa). ✓
- Lớp B: determinant duy nhất là `(parent_id, ord)` (khóa). ✓
- Lớp C: determinant duy nhất là `(parent_id, path)` (khóa); `kind` chỉ ràng buộc *cột giá trị nào khác NULL* (`SUM((value_text IS NOT NULL)+(value_number IS NOT NULL)+(value_bool IS NOT NULL)) > 1` = **0 dòng** trên live), không xác định giá trị nên không tạo FD `kind → …`. ✓

**Lưu ý BCNF về mảng có ngữ nghĩa tập hợp:** nếu một mảng không bao giờ lặp phần tử thì `(parent_id, ref_id) → ord` trở thành FD với vế trái **không phải siêu khóa** → vi phạm BCNF tiềm tàng. Kiểm chứng live hiện tại:

```sql
SELECT parent_id, ref_id, COUNT(*) c FROM order__items      GROUP BY 1,2 HAVING c>1;  -- 0 dòng
SELECT parent_id, ref_id, COUNT(*) c FROM order__payments   GROUP BY 1,2 HAVING c>1;  -- 0
SELECT parent_id, ref_id, COUNT(*) c FROM menu_item__categories GROUP BY 1,2 HAVING c>1;  -- 0
SELECT parent_id, ref_id, COUNT(*) c FROM inventory_item__stores GROUP BY 1,2 HAVING c>1;  -- 0
SELECT parent_id, ref_id, COUNT(*) c FROM inventory_item__locations GROUP BY 1,2 HAVING c>1;  -- 0
```

Thiết kế **cố ý cho phép lặp** (giỏ hàng có thể thêm cùng modifier 2 lần — `order_item__modifiers`), nên không gắn `UNIQUE(parent_id, ref_id)` vơ vét. Khuyến nghị: chỉ thêm UNIQUE cho các mảng đã xác định là tập hợp thuần (`menu_item__categories`, `user__roles`, `inventory_item__stores/locations/suppliers`, `user__branch_ids`, `discount__applicable_floors`, `floor_table__*`).

## 7. 4NF / 5NF — **ĐẠT ở mức thực hành**

- **4NF (MVD):** các fact đa trị **độc lập** được tách bảng riêng từ đầu — `order__items`, `order__payments`, `order__tags`, `order__extras` là 4 bảng khác nhau thay vì một bảng kết hợp. Không tồn tại bảng chứa hai quan hệ đa trị độc lập → không có MVD non-trivial ngoài khóa.
- **5NF (JD):** mọi đường join đều là FK tường minh (625 FK trên live); không có bảng 3-chiều cần phân rã.
- **Bảng EAV** `(parent_id, path) → 1 giá trị` thực chất là phân rã tới mức **mỗi fact một dòng** (gần 6NF về cấu trúc) — đánh đổi: mất kiểu tĩnh & ràng buộc theo trường, đổi bằng khả năng chứa field phát sinh. Quy trình "thăng cấp" đã có: bảng SCHEMALESS có dữ liệu → chạy lại `generate.mjs` → field thành cột thật.

## 8. Bảng tổng kết & khuyến nghị

| Chuẩn | Yêu cầu | Verdict | Bằng chứng |
|---|---|---|---|
| **1NF** | Giá trị nguyên tử, hết lặp nhóm | **Đạt — 412/412** | mảng → 73 bảng con; lồng → EAV; JSON nghiệp vụ = 0 (§3) |
| **2NF** | Không phụ thuộc một phần khóa | **Đạt — 110/110 bảng khóa phức hợp** | cấu trúc 1-cột-giá-trị của mọi bảng con/EAV (§4) |
| **3NF** | Không phụ thuộc bắc cầu | **Đạt về khóa**; 20 cột snapshot có chủ ý (nhóm A) + 2 cụm đã ghi chính sách (nhóm B) | quét DDL + truy vấn live §5 |
| **BCNF** | Mọi determinant là siêu khóa | **Đạt**; lưu ý mảng-tập-hợp có khuyến nghị UNIQUE chọn lọc | §6, 5/5 bảng mảng kiểm chứng 0 trùng |
| **4NF** | Không MVD non-trivial | **Đạt** — fact đa trị tách bảng riêng | §7 |
| **5NF** | Không JD ẩn | **Đạt (thực hành)** — 625 FK tường minh | §7 |

**Khuyến nghị (theo thứ tự ưu tiên):**

1. **Giữ nguyên 20 cột snapshot nhóm A** — đây là yêu cầu đúng đắn của sổ tài chính; chỉ cần bảo đảm khi thêm cột dẫn xuất mới phải biện luận trong `report.json`/tài liệu này.
2. **Chốt chính sách nhóm B1** (`order_item.category/menu`): quyết định hiện tại là snapshot — ghi rõ trong code review nếu ai muốn "dọn" 2 cột này sang JOIN.
3. **UNIQUE chọn lọc cho mảng tập hợp**: `ALTER TABLE menu_item__categories ADD UNIQUE KEY (parent_id, ref_id)` (và các bảng liệt kê ở §6) — biến lưu ý BCNF thành ràng buộc thật.
4. **Bảng quy đổi UoM** (`inventory_uom_conversion`) nếu nghiệp vụ nhập kho tăng — giải cụm B2 triệt để.
5. **Duy trì quy trình thăng cấp EAV**: chạy lại `npm run db:relational:generate` sau khi bảng SCHEMALESS có dữ liệu; cột mới vào `__attrs` là hành vi đúng, không phải nợ chuẩn hóa.

**Kết luận:** lược đồ quan hệ `restaurant_manager_relational` đạt **1NF, 2NF, BCNF, 4NF toàn bộ**; đạt **3NF** với các ngoại lệ đã được biện luận rõ (20 cột snapshot tài chính có chủ ý + 2 cụm trùng lặp có chính sách). Các chuẩn cao hơn không mâu thuẫn gì với mô hình hiện tại.

---

## Phụ lục — script kiểm chứng dùng trong tài liệu

Toàn bộ truy vấn trong tài liệu chạy trực tiếp trên `restaurant_manager_relational` (DB_HOST=127.0.0.1, DB_PORT=3307). Đếm phân lớp từ DDL:

```bash
# số bảng cha / bảng con / EAV từ 001_tables.sql (nhớ nháy đơn vì tên cột có backtick)
grep -c 'PRIMARY KEY (`id`)' migrations/relational/001_tables.sql                 # 167
grep -c 'PRIMARY KEY (`parent_id`, `ord`)' migrations/relational/001_tables.sql   # 73
grep -c 'PRIMARY KEY (`parent_id`, `path`)' migrations/relational/001_tables.sql  # 37
```

```sql
-- kiểm chứng 1NF live: cột JSON chỉ được phép ở metadata
SELECT table_name, column_name FROM information_schema.columns
 WHERE table_schema='restaurant_manager_relational' AND data_type='json';
-- kiểm chứng 2NF/BCNF live: EAV không bao giờ có 2 giá trị cho 1 path
SELECT COUNT(*) FROM order__attrs
 WHERE (value_text IS NOT NULL)+(value_number IS NOT NULL)+(value_bool IS NOT NULL) > 1;  -- 0
```
