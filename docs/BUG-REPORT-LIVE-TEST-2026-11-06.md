# BÁO CÁO KIỂM THỬ LIVE TOÀN BỘ APP & DANH SÁCH LỖI CHI TIẾT

**Ngày test:** 2026-11-06 (bắt đầu ~23:05, kết thúc ~00:15 giờ VN, 2026-11-06 → 2026-11-07)
**Phương pháp:** Black-box GUI thuần — thao tác như người dùng thật qua trình duyệt (click, gõ, bàn phím số), chụp ảnh màn hình mỗi bước. **Không dùng script tự động, không đọc/sửa code.**
**Phạm vi:** Build app từ mới — factory reset DB → bootstrap → test tuần tự **từng role → từng chức năng trong role**.

---

## 1. Chuẩn bị môi trường (không tính là kết quả test)

| Bước | Lệnh / thao tác | Kết quả |
|---|---|---|
| Reset DB về xuất xưởng | `./reset-app.sh --yes` | ✅ Backup 1.8 MB (`backups/mysql/pre-reset-20261106T161259Z.sql`), xoá 1.068 dòng, truncate change_log, `needsBootstrap: true` |
| Chạy app | Docker compose + overlay `docker-compose.ui.yml` | ✅ Vite chạy ở **port 5174** (đã đổi từ 5173 theo commit `91f3e09`) |

Tài khoản phát sinh trong quá trình test (tạo qua UI, không seed tay):
- **Admin / PIN 1111** — role **Master** (tạo bằng wizard bootstrap)
- **Staff 1 (Test) / PIN 2222** — role **Staff** (role Staff cũng tạo qua UI: Thực đơn + Đơn hàng)

---

## 2. Tổng kết phạm vi đã test

### Role Master (Admin) — 13/13 module trong sidebar
| Module | Trạng thái |
|---|---|
| Thực đơn (POS order) | ⚠️ Dùng được nhưng có BUG #2, #3, #4, #12 (xem mục 3) |
| Đơn hàng | 🐞 BUG #5 (lọc ngày) — danh sách trống ở phiên Admin |
| Tổng hợp | ✅ Số liệu đúng · 🐞 BUG #6 (lịch highlight lệch 1 ngày) |
| Bếp | ✅ Nhận phiếu, Sẵn sàng, thời gian trung bình hoạt động |
| Màn hình đơn | ✅ Popup "Sẵn sàng lấy", cột Đang chế biến/Sẵn sàng lấy |
| Chốt ca | ⚠️ Tải đúng kỳ + số liệu khớp · 🐞 BUG #8 (Lưu bản nháp mất dữ liệu) |
| Tồn kho (20 tab con) | ✅ Render OK · 🐞 BUG #5-family ở tab Đối chiếu bếp |
| Quản lý (19 tab con) | ✅ Render OK, tạo role + user thành công · ⚠️ BUG #7-minor (bắt buộc Họ) |
| Báo cáo | ✅ Sinh đúng số liệu (mở tab mới — BUG #9-minor UX) |
| Sổ sách (10 tab) | ✅ Render OK (dữ liệu kế toán rỗng — chưa setup, không phải lỗi) |
| Nhân sự | 🐞 **BUG #10 (nghiêm trọng)** — lỗi DB thô, toàn bộ KPI = 0 |
| Tích hợp | ✅ Render OK (6 provider, mặc định tắt) |
| Cài đặt | ✅ Render OK |

### Role Staff (Staff 1 / 2222)
- ✅ Đăng nhập PIN, gate "Cần chấm công", chấm công xong vào app
- ✅ Sidebar: module ngoài quyền có icon khoá; bấm "Quản lý" → mở modal "Xác thực để truy cập admin" đúng thiết kế
- ✅ Thực đơn: tạo đơn Bàn 2/2 khách, thêm Trà đào, gửi bếp (nhưng gặp BUG #2/#12), đơn về lưới bàn đúng
- ✅ Đơn hàng: thẻ đơn hiển thị đúng
- 🐞 **BUG #11 (RBAC leak)** — bị đưa thẳng vào /settings và **tương tác được** (đổi ngôn ngữ thành công)
- 🐞 **BUG #13 (nghiêm trọng)** — 1 thao tác "Gửi bếp" tạo **2 đơn trùng nhau #7 & #8**

### Các role khác
Sau bootstrap, hệ thống chỉ có role **Master**. Các role khác **chưa tồn tại** cho tới khi admin tự tạo qua UI (đã test luồng tạo role "Staff" với 13 checkbox phân hệ — hoạt động). Không còn role mặc định nào để test → phần này kết luận: app không đi kèm role mẫu, mọi role phải tự dựng.

---

## 3. DANH SÁCH LỖI CHI TIẾT

> Ảnh evidence nằm trong `gui-test-screenshots/` (đường dẫn tương đối so với repo root).

### 🔴 BUG #1 — Sau khi tạo Admin bằng wizard, app văng về trang Đăng nhập kèm modal "Cần chấm công" đè lên
- **Mức độ:** Thấp (UX/nhất quán) — luồng vẫn đi tiếp được
- **Bước tái hiện:** DB trống → đăng nhập PIN 0000 → wizard "Tạo tài khoản Admin" → nhập tên + PIN ×2 → bấm "Tạo Admin"
- **Kỳ vọng:** Sau tạo Admin, vào thẳng app (hoặc màn hình chấm công sạch)
- **Thực tế:** Quay về màn "Đăng nhập" (thấy PIN pad) và modal "Cần chấm công — Bạn cần chấm công trước khi truy cập hệ thống" đè lên trang login. Bấm "Chấm công" → toast "Chấm công thành công" → vào app bình thường.
- **Evidence:** `t2_bug1_clockin_gate_after_bootstrap.png`

### 🔴 BUG #2 — Click món ĐẦU TIÊN sau khi tạo đơn bị nuốt/mất; trạng thái header tự đổi
- **Mức độ:** Cao (mất thao tác đầu tiên của mọi đơn)
- **Bước tái hiện (phiên Admin):** Chọn Bàn 1 → "Chọn số người" → 2 → OK (vào màn order, header [Sảnh chính][Bàn 1][2 khách]) → click "Cà phê đen"
- **Thực tế:** Click thứ nhất không vào giỏ; sau chuỗi click (Cà phê đen ×1, Phở bò ×2) header tự đổi thành **[Bàn 2][1 khách]** kèm nút "Xoá", giỏ chỉ còn 2× Phở bò. Ở phiên Staff: click Trà đào đầu tiên cũng bị nuốt (Món (0)), click lần 2 mới vào.
- **Evidence:** `t5_bug2_wrong_table_after_item_click.png`, `t26_staff_order_tradao.png` (phiên Staff, sau click đầu)

### 🔴 BUG #3 — Đơn lưu bị sai nội dung so với giỏ (món bị map sai + line bị mất)
- **Mức độ:** Nghiêm trọng (dữ liệu đơn sai → sai bếp, sai tiền)
- **Bước tái hiện:** Đúng kịch bản BUG #2 (Admin, click Cà phê đen ×1 + Phở bò ×2)
- **Thực tế:** Đơn #6 cuối cùng trên Bàn 1 chứa **1× Trà đào + 1× Phở bò** (= ₫110.000 gồm phụ thu Trà đá 5.000) — KHÔNG có Cà phê đen nào cả, và chỉ còn 1 Phở bò thay vì 2. Kitchen Display xác nhận đúng nội dung sai này (`t9_kitchen_ticket.png`).
- **Evidence:** `t7_bug4_wrong_item_in_order.png`, `t9_kitchen_ticket.png`

### 🔴 BUG #4 — Nút "Huỷ" không xoá được đơn đã tạo; đơn tiếp tục chiếm bàn
- **Mức độ:** Cao (nhân viên không thể dọn đơn nháp)
- **Bước tái hiện:** Đang ở màn đơn Bàn 1 (đã có món, đơn #6) → bấm "Huỷ"
- **Kỳ vọng:** Huỷ bỏ đơn nháp (hoặc hỏi xác nhận xoá đơn)
- **Thực tế:** Quay về lưới bàn, **Bàn 1 vẫn bị chiếm** với đơn #6 ₫110.000 (timer đang chạy, "(Admin)")
- **Evidence:** `t6_bug3_huy_left_order_on_ban1.png`

### 🔴 BUG #5 — Lịch chọn ngày lệch -1 ngày + không chọn được hôm nay ⇒ màn "Đơn hàng" không bao giờ xem được đơn trong ngày
- **Mức độ:** Nghiêm trọng (chức năng chính vô dụng cho ngày hiện tại)
- **Bước tái hiện (Đơn hàng, phiên Admin):** Mở module → ô ngày mặc định **2026-11-05 (hôm qua)** dù hôm nay 06/11 → danh sách **trống** dù đơn #6 đã thanh toán hôm nay.
  1. Gõ tay "2026-11-06" + Enter → giá trị bị revert về 05/11
  2. Click ngày 6 trong lịch → im lặng (không đổi)
  3. Click nút "Today" → im lặng
  4. Click ngày 7 → im lặng (ngày ≥ hôm nay bị chặn ngầm; cả "Next month"/"Next year" disabled)
  5. Click ngày 4 → giá trị thành **2026-11-03**; click ngày 2 → thành **2026-11-01** (lệch -1 ngày, 3/3 phép thử)
- **Kỳ vọng:** Mặc định hôm nay; chọn được hôm nay; ngày chọn khớp ngày click
- **Lưu ý:** Cùng hiện tượng default 2026-11-05 ở tab **Đối chiếu bếp** (Tồn kho) và tab **Chấm công** (Nhân sự). Ở tab Chấm công, bản ghi 06/11 vẫn hiện (filter bị bỏ qua?) — hành vi không nhất quán với Đơn hàng.
- **Evidence:** `t16_bug5_orders_empty_default_yesterday.png`, `t17_bug5_date_future_blocked.png`, `t17_bug5_date_offbyone_2to1.png`

### 🟡 BUG #6 — Tổng hợp: lịch highlight sai ngày (chỉ lỗi hiển thị)
- **Mức độ:** Thấp (số liệu đúng)
- **Bước tái hiện:** Mở Tổng hợp — tiêu đề báo cáo "Bảng tổng hợp doanh thu ngày — **2026-11-06**" nhưng lịch bên trái highlight ngày **05** (06 mới được viền "today")
- **Evidence:** `t18_tonghop_report_ok_cal_offbyone.png`

### 🟡 BUG #7 — Form "Tạo người dùng mới" bắt buộc "Họ" nhưng chỉ báo lỗi sau khi bấm Lưu; không nhất quán với user bootstrap
- **Mức độ:** Thấp (validation UX)
- **Bước tái hiện:** Quản lý → Người dùng → "+ Người dùng" → điền Tên/PIN/Vai trò, bỏ trống Họ → Lưu
- **Thực tế:** Báo lỗi đỏ "Trường này là bắt buộc" dưới Họ **sau khi submit**. User Admin tạo bởi bootstrap thì Họ trống vẫn hợp lệ.
- **Evidence:** ảnh trong transcript (bước trước khi lưu thành công), `t22_staff_user_created.png` (sau khi điền Họ)

### 🔴 BUG #8 — Chốt ca: "Lưu bản nháp" không có phản hồi và dữ liệu đếm tiền bị mất
- **Mức độ:** Cao (mất công đếm tiền ca)
- **Bước tái hiện:** Chốt ca → Terminal 1 → chế độ "Nhập tổng" → bàn phím số nhập 120500 (Thừa/thiếu về ₫0 đúng) → bấm "Lưu bản nháp"
- **Thực tế:** Không toast thành công/lỗi nào; form tự reset về ₫0. **Reload trang → bản nháp không được khôi phục** (Tiền mặt đã đếm ₫0, Thừa/thiếu -₫120.500). Không xác định được là lưu-fail hay lưu-ok-nhưng-không-hydrate (không đọc code theo yêu cầu) — với người dùng, dữ liệu đã nhập biến mất.
- **Evidence:** `t19_chotca_counted_ok.png` (trước lưu), `t20_bug8_draft_not_restored.png` (sau reload)

### 🟡 BUG #9 — Báo cáo: bấm "Tạo" không có phản hồi ở trang chính; báo cáo mở tab mới ngầm
- **Mức độ:** Thấp (UX) — báo cáo sinh đúng
- **Bước tái hiện:** Báo cáo → Doanh thu → Tổng hợp doanh thu → giữ "Today" → bấm "Tạo"
- **Thực tế:** Trang chính không loading/toast/đổi gì cả trong ≥4 giây ⇒ tưởng bị hỏng. Báo cáo thực tế mở **tab trình duyệt mới** (`/reports/sales-summary?start=2026-11-06 00:00&end=2026-11-06 23:59`) với số liệu đúng (thuần 105.000, đã thu 120.500, thuế 10.500, chia buổi đúng). Nhãn "Lợi ích làm tròn" dịch lạ (Rounding).
- **Evidence:** DOM snapshot của tab báo cáo (tab này bị hạn chế chụp ảnh bởi runtime); `gui-test-screenshots/` không có ảnh tab này

### 🔴 BUG #10 — Nhân sự: lỗi DB thô surfaced lên UI, toàn bộ 14 KPI = 0
- **Mức độ:** Nghiêm trọng (module dashboard hỏng, leak lỗi nội bộ)
- **Bước tái hiện:** Mở module Nhân sự (Bảng điều khiển)
- **Thực tế:** Toast lỗi đỏ: **"There was a problem with the database: Expected ')' but got string '9999-12-31T23:59:59Z'"** — trông như lỗi parse query ở tầng DB/dbproxy với chuỗi ngày biên. Tất cả thẻ KPI (Đã có mặt, Ca hôm nay, Chi phí nhân sự... ) = 0. Tab "Chấm công" trong cùng module thì hoạt động (bản ghi Admin 23:15 hiện đúng) ⇒ lỗi nằm ở truy vấn dashboard.
- **Evidence:** `t23_bug10_hr_db_error.png`

### 🔴 BUG #11 — RBAC leak: phiên Staff bị đưa thẳng vào /settings và tương tác được
- **Mức độ:** Nghiêm trọng (bảo mật/phân quyền)
- **Bước tái hiện:** Đang đăng nhập Admin ở /settings → Đăng xuất → đăng nhập Staff 1/2222 → chấm công
- **Thực tế:** App khôi phục route cũ của thiết bị (/settings) và **render toàn bộ nội dung Cài đặt cho Staff** (không có modal khoá). Click nút "English" **thành công** — Staff đổi được ngôn ngữ thiết bị ⇒ trang không chỉ xem mà còn sửa được. (Modal "Xác thực để truy cập admin" chỉ xuất hiện khi bấm nav item ngoài quyền — đã verify — chứ không chặn trang đang mở.)
- **Kỳ vọng:** Sau đăng nhập/hoặc khi route không được phép → redirect về module được phép (Thực đơn) hoặc chặn bằng modal
- **Evidence:** `t25_bug11_staff_settings_interactive.png` (UI đã chuyển English trong phiên Staff)

### 🔴 BUG #12 — "Gửi bếp" im lặng khi fail/không phản hồi: 2 click đầu không có任何 phản hồi, click thứ 3 mới gửi
- **Mức độ:** Cao (đi thẳng tới BUG #13)
- **Bước tái hiện (phiên Staff):** Đơn Bàn 2 có 1 Trà đào → bấm "Gửi bếp" → **không toast, không điều hướng, giỏ vẫn còn** → bấm "Sảnh chính" → hộp "Vui lòng xác nhận (Giỏ có 1 món, hãy chọn thao tác)" → bấm "Gửi bếp" trong hộp → lại im lặng → bấm "Gửi bếp" lần 3 → mới thành công (về lưới bàn, Bàn 2 có đơn)
- **Kỳ vọng:** 1 click = 1 lần gửi, có phản hồi ngay (điều hướng + toast), có idempotency
- **Evidence:** `t26_staff_order_tradao.png`, ảnh transcript các bước (confirm dialog), `t27_staff_order_sent_ban2.png`

### 🔴 BUG #13 — Hậu quả của BUG #12: một thao tác người dùng tạo ra 2 đơn trùng nhau
- **Mức độ:** **Nghiêm trọng nhất** (toàn vẹn dữ liệu bán hàng)
- **Bước tái hiện:** Đúng kịch bản BUG #12
- **Thực tế:** Màn Đơn hàng (Staff) hiển thị **Đơn #7 (11:54) và Đơn #8 (11:55)** — đều "Trà đào / Món (1) / ₫45.000 / Bàn 2 / ĐANG THỰC HIỆN". Hai cú click "bị nuốt" thực chất đã gửi thành công ngầm 2 lần ⇒ khách bị tính gấp đôi nếu không soi kỹ.
- **Kỳ vọng:** Nút phải disable + hiển thị "đang gửi" sau click thứ nhất; server cần idempotency
- **Evidence:** `t28_bug13_duplicate_orders.png`

### 🟡 Các vấn đề nhỏ khác (cosmetic/polish)
1. **Chip lọc "Màn hình đơn" hiển thị raw enum** `status.inProgress` thay nhãn dịch (`t11_order_screen_ready_popup.png`)
2. **Title tab trùng**: "Tồn kho | Tồn kho | POS Nhà hàng"
3. **Giá vốn hiển thị 4 số lẻ** `₫20,000.0000` ở Tồn kho/Nguyên liệu (`t21_inventory_main.png`)
4. **Nhãn giỏ sai**: "Tổng cộng gồm VAT 10%" trong khi thuế mặc định = ₫0 (`t4_pos_order_screen_ban1.png`, `t12_payment_dialog.png` — Thuế chỉ được áp bằng nút VAT trong dialog)
5. **Dòng món trong giỏ hiển thị số thô** `45000`/`60000` không định dạng tiền (`t7_bug4_wrong_item_in_order.png`)
6. **Numpad giữ số 0 đầu** ("0120500") khi nhập tổng tiền Chốt ca (`t19_chotca_counted_ok.png`)
7. **"Mở két tiền" và "In bảng tổng hợp"/"In bảng chốt ngày"** không có phản hồi UI nào khi bấm (không xác minh được hành vi phần cứng)
8. **2 báo cáo "Nhân công theo giờ doanh thu…" nằm nhầm nhóm "Doanh thu"** (trùng với nhóm "Nhân công")
9. Sau bootstrap **không có role mẫu nào ngoài Master** — mọi role phải tự dựng tay

---

## 4. Các chức năng ĐÃ KIỂM TRA HOẠT ĐỘNG ĐÚNG (không phải lỗi)

- Factory reset + bootstrap PIN 0000 + wizard tạo Admin + xác thực lại PIN thường
- Gate "Cần chấm công" cho user chưa có time_entry (cả Admin lẫn Staff)
- Tạo role mới (checkbox 13 phân hệ) + tạo user gán role qua UI
- Luồng order đầy đủ (Admin): Bàn 1/2 khách → món → Gửi bếp → Bếp nhận phiếu → "Sẵn sàng" → Màn hình đơn popup "Sẵn sàng lấy" → Thanh toán: áp VAT 10% (10.500 đúng), quick-cash ₫120.500, "Hoàn tất" → bàn trống
- Tổng hợp doanh thu khớp penny với đơn đã thanh toán; báo cáo Tổng hợp doanh thu đúng số liệu + export In/XLSX/PDF/Ảnh
- Chốt ca: kỳ đóng đúng (06:00 → 02:00), doanh thu tiền mặt hệ thống khớp, tính Thừa/thiếu đúng khi nhập
- Tồn kho 20 tab + Quản lý 19 tab render không lỗi; Sổ sách/Tích hợp/Cài đặt render đầy đủ
- RBAC: sidebar Staff khóa đúng các module ngoài quyền (icon 🔒), modal "Xác thực để truy cập admin" khi bấm module khóa, Staff dùng tốt Thực đơn + Đơn hàng

---

## 5. Phân bổ theo mức độ nghiêm trọng

| Mức | Bug |
|---|---|
| **Nghiêm trọng** | #3 (đơn sai món/tiền), #5 (không xem được đơn trong ngày), #10 (Nhân sự hỏng + leak lỗi DB), #11 (Staff sửa được Settings), #13 (đơn trùng) |
| **Cao** | #2 (nuốt click món đầu), #4 (Huỷ không xoá đơn), #8 (Lưu nháp mất dữ liệu), #12 (Gửi bếp im lặng) |
| **Thấp/Polish** | #1, #6, #7, #9 + 9 mục cosmetic |

**Khuyến nghị ưu tiên sửa:** BUG #12/#13 (nhấn 1 lần tạo 2 đơn — mất tiền thật) → BUG #3 (đơn sai món) → BUG #5 (lọc ngày) → BUG #11 (phân quyền) → BUG #10 (Nhân sự) → BUG #8 (chốt ca) → còn lại.

---

## 6. Ghi chú về giới hạn kiểm thử

- Console log trình duyệt không thu được (runtime không cho listener đọc-đọc); mọi kết luận dựa trên biểu hiện trên trang + DOM read-only + ảnh.
- Tab báo cáo (mở popup) bị runtime từ chối chụp ảnh — đã xác minh nội dung bằng DOM snapshot.
- Các nút in/mở két không thể xác minh phần cứng trong môi trường này.
- Phần không-đọc-code là yêu cầu của người dùng: nguyên nhân gốc chỉ mô tả theo biểu hiện quan sát được.
