# ADR 0007: Xóa hết thương hiệu cũ — kể cả định danh đã ghi xuống dữ liệu

## Status

Accepted — 2026-10-30. Supersedes the "giữ lại định danh giao thức/lưu trữ" carve-out in ADR 0006 §Scope và §6.7 của CONSOLIDATION-PLAN.

## Context

Lượt đổi tên trước chỉ chạm tên hiển thị + package/image và cố ý giữ nhóm `posr-*` vì cho rằng chúng là định danh đã ghi xuống DB hoặc là hợp đồng giao thức. Chủ repo chốt: **đổi hết, không giữ**.

Vấn đề thật của quyết định đó: một số chuỗi không nằm trong code, mà nằm trong **dữ liệu đã ghi** — hàng đợi/secrets của máy nhân viên thu ngân (IndexedDB, localStorage), row cài đặt chính sách đánh số chứng từ, row ánh sánh kế toán, item đã tạo trên sổ QuickBooks của khách hàng, và chính tên namespace/database SurrealDB. Đổi thuần tuý làm những chỗ đó "trôi" im lặng: app đọc không thấy key cũ, chính sách số rơi về preset khác (đổi cách đánh số hoá đơn), tạo item trùng trên sổ kế toán, hoặc mở một database rỗng.

## Decision

1. **Không còn ngoại lệ thương hiệu.** Mọi định danh trong repo dùng tiền tố mới: event `restaurant-manager-*`, namespace/database SurrealDB `restaurant_manager`, issuer `restaurant-manager-gateway`, cookie `restaurant_manager_*`, deep link `restaurant-manager-auth://`, key i18n `brandLogoAlt`/`fiscal_plus_brand`, module `src/routes/restaurant-manager.ts`, env `RESTAURANT_MANAGER_REPO_ROOT`, project compose `restaurant-manager`, license `Restaurant Manager Source Available License (RMSAL)`.
2. **Họ identifier "bản ghi phía app" đổi thành tên trung tính**, không phải tên thương hiệu mới: `posrId/posrOrderId/posrCustomerId/posrPaymentId/posrRefundId/posrJournalId` → `localId/localOrderId/…`, field DB `posr_id` → `local_id`, enum `posr_to_external` → `local_to_external`. Lý do: chúng mô tả phía nào trong bản đồ hai chiều, không mô tả sản phẩm.
3. **Dữ liệu đã ghi được migrate, không bị bỏ rơi:**
   - Browser storage: `src/lib/legacy-storage.ts` + `migrateLegacyStorage()` chạy một lần ở `main.tsx` trước i18n và trước khi mount app; copy localStorage/sessionStorage, 4 store idb-keyval và Dexie PosStore từ tên cũ sang tên mới, **không xoá bản cũ**, guard "bên đích chưa có dữ liệu". Test chứng minh cả copy, không ghi đè, và chạy lần hai vô hại (kèm negative control: đổi sai tên đích thì test đỏ).
   - SurrealDB: `migrations/2026_10_31_brand_rename.surql` copy `posr_id` → `local_id` trên cả `integration_entity_mapping` và `integration_sync_failure`, đổi index UNIQUE sang `idx_entity_mapping_local`, và ghi lại `values.syncDirection` trong `integration_provider_config`. Idempotent.
   - Namespace/database thật (`posr` → `restaurant_manager`): không có `RENAME NAMESPACE` trong SurrealDB, nên đây là một **data move** — `scripts/rename-surreal-namespace.mjs` (UPSERT theo `meta::id`, kiểm tra mọi rid nguồn đều có ở đích, mặc định không xoá nguồn). Operator chạy tay sau khi đã apply migration vào ns/db mới.
4. **Ba chỗ vẫn chứa chuỗi cũ, và đó là code migration chứ không phải thương hiệu:** `src/lib/legacy-storage.ts` (+ test của nó) cần tên storage cũ để copy; `LEGACY_SYNC_DIRECTION_VALUES` trong `src/integrations/accounting/external/config.ts` và `LEGACY_PRESET_ALIASES` trong `src/lib/number-policy.ts` / `gateway/src/number-policy.js` cần tên cũ để đọc row đã lưu; `LEGACY_SALE_ITEM_NAME` trong QuickBooks provider cần tên item cũ để **dùng lại** item đã tồn tại trên sổ khách hàng thay vì tạo item thứ hai.
5. **Hệ quả chấp nhận:** JWT issuer đổi → phiên đang hoạt động phải đăng nhập lại; cookie đổi → cùng một hệ quả; `posr-auth://` đổi → app quét mã ở ngoài repo phải nhận scheme mới (trong repo không có bên parse, đã kiểm tra bằng grep); tài liệu PDF đổi tên file.

## Verification

`node scratch/verify-migrations.mjs` trên `surrealdb/surrealdb:v3.0.5` chạy thật: 11/11 kiểm tra đạt, gồm "giá trị `posr_id` biến mất hẳn khỏi row" (SCHEMALESS và SCHEMAFULL), index UNIQUE mới thật sự chặn trùng, patch chạy lại không phá dữ liệu, `latest.surql` và `2026_08_03_*.surql` không còn `posr`. Ba phát hiện chỉ có được khi chạy thật: `SET x = NONE` và `UNSET x` bị từ chối khi field còn `TYPE string` (phải relax thành `option<string|null>` trước), `REMOVE FIELD` không xoá giá trị đã ghi, và `CREATE … OVERWRITE` không phải cú hợp lệ (dùng `UPSERT`).

`scripts/rename-surreal-namespace.mjs` chạy thật: copy 3 record qua 6 bảng, báo `match` cho `demo_log` và `order`, và chạy lần hai vẫn `match` (idempotent).

## Consequences

Repo không còn chỗ nào mang tên cũ ngoại trừ các hằng legacy có chủ đích ở mục 4. Đổi brand giờ đây là một thao tác có migration, không phải một lần find-replace — vì vậy mọi lần chạy `docker compose up` mới đều phải dùng `SURREAL_NS=restaurant_manager`, và ai đang có database `posr` phải chạy bước move ở mục 3 trước khi bật app.
