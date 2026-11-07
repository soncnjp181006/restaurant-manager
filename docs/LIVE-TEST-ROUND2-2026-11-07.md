# Live test vòng 2 — role 1 (Master), các chức năng chưa được phủ

**Ngày:** 2026-11-07 (bắt đầu 09:04 giờ VN) · **Nhánh:** `refactor-ui` · **Build:** `063c889` + thay đổi UI chưa commit ("Quầy đêm 2.0")
**Phương pháp:** thao tác thật trên UI (Vite host, port 5174) bằng driver `scratch/ui-driver.js`, đối chiếu từng bước với MySQL thật qua `scratch/live-census.mjs`.
**Phạm vi:** phần còn lại của role 1 mà hai báo cáo trước chưa phủ (`docs/LIVE-TEST-FRESH-DB-2026-11-06.md` mục 4, `docs/BUG-REPORT-LIVE-TEST-2026-11-06.md` mục 6).

---

## 1. Môi trường sau khi máy ngủ qua đêm

Stack đã chết toàn bộ (Docker Desktop tắt, Vite tắt) — chỉ còn MySQL native của Windows trên 3306.

| Bước | Kết quả |
|---|---|
| Bật Docker Desktop | `C:\Users\Nexus\AppData\Local\Programs\DockerDesktop\Docker Desktop.exe` → engine 29.8.2 |
| Container tự sống lại | dbproxy, mysql, api, sync, backup (restart policy) |
| Container phải bật tay | `docker compose up -d gateway printer payment tracking` |
| **Không** bật `app` | container `app` ánh xạ cổng 5174 sẽ đụng Vite host → giữ trạng thái Exited |
| Vite host | `npm run dev` → 5174 (log `scratch/dev-server-20261107.log`) |
| Health | 6 sidecar `/health` = 200 (3132 print, 3134 payment, 3136 sync, 3138 tracking, 3140 api, 3142 gateway) |
| MySQL container | cổng **3307** (`.env` `MYSQL_HOST_PORT=3307`) → không đụng MySQL native 3306 |
| Bootstrap | `GET :3142/auth/status` → `{"ok":true,"needsBootstrap":false}` |

**DB hiện tại không phải trạng thái trong báo cáo trước.** Một phiên khác đã `./reset-app.sh --yes` lúc ~01:36–01:37 VN (backup `pre-reset-20261106T183605Z.sql`, `pre-reset-20261106T183707Z.sql`) rồi test lại 13 bug. Dữ liệu đầu phiên này:

`user` 1 (login **1111**, role `bootstrap_master`) · `user_role` 1 (Master) · `menu_item` 3 (Cà phê đen D01, Trà đào D02, Phở bò D03) · `floor_table` 2 (Bàn 1, Bàn 2) · `order` 3 (#204 Cancelled, #205 Paid, #206 In Progress — đều Bàn 1) · `order_void` 3 (lý do "Punch By Mistake", cùng trỏ về #204) · `order_payment` 1 (102.900) · `time_entry` 1 · `employee` 4.

→ Không xoá lại DB (dữ liệu này do phiên test trước tạo, không phải dữ liệu khách thật). Mọi bản ghi mới trong phiên này đều ghi rõ bên dưới.

## 2. Đã test trực tiếp trên UI (kèm đối chiếu MySQL)

### 2.1 Giỏ hàng / màn Thực đơn

| Chức năng | Thao tác | Kết quả |
|---|---|---|
| Xoá giỏ (`menu-clear-cart`) | bấm khi giỏ có 1 Cà phê đen | ✅ giỏ trống, không cần xác nhận |
| **Click món đầu tiên** (regression BUG #2/#3) | giỏ trống → bấm Phở bò 1 lần | ✅ vào giỏ đúng 1 Phở bò ₫60.000, header giữ nguyên Bàn 2/1 khách — không nuốt click, không map sai món |
| Đổi loại đơn | Tại bàn → Mang đi → Tại bàn | ✅ class `active` chuyển đúng chiều |
| Số khách | bấm "1 khách" → keypad 2 → OK | ✅ header "2 khách", `order.covers = 2` |
| Ghi chú món | "Ghi chú" → bàn phím ảo gõ `it duong` → Đóng | ✅ giỏ hiện `(it duong)`, **`order_item.comments = "it duongg"`** trong MySQL |
| Tăng/giảm số lượng | Thêm ×2 → Gỡ ×1 | ✅ 60.000 → 120.000 → 180.000 → 120.000 |
| Bàn phím ảo | gõ bằng nút chữ | ✅ hoạt động; **ghi giá trị trực tiếp vào input thì bị React đẩy về** (controlled input) — không phải bug, là đặc tính |

### 2.2 Thanh toán (đơn mới tạo trong phiên này)

Đơn **#4** (`order:97JvRFR9Kj2qJWmLBgfeK`, `auto_id 6`, Bàn 2, 2 khách, 2× Phở bò):

| Bước | Kết quả |
|---|---|
| "Thanh toán ngay" | ✅ mở dialog, tự tạo đơn #4 trạng thái ĐANG THỰC HIỆN |
| Phụ thu tự động | ✅ "Trà đá ₫5.000" (`order.extras` có 1 phần tử) |
| Thuế mặc định | ⚠️ **"Không thuế" — Thuế ₫0**, tổng ₫125.000 (xem Lỗi R2-1) |
| Áp VAT 10% | ✅ Thuế (VAT 10%) **₫12.000** trên ₫120.000 tiền món (không tính phụ thu), tổng **₫137.000**; nút quick-exact tự đổi thành ₫137.000 |
| Quick tender + Hoàn tất | ✅ "Tiền thừa: ₫0", dialog đóng, về lưới bàn, Bàn 2 trống |
| Đối chiếu MySQL | ✅ `order.status = Paid`, `tax_amount = 12000`, `order_tax.amount = 12000`, `order_payment.amount = 137000`, `completed_at` có giá trị, `invoice_number = 4` (khớp "#4" trên UI) |
| In hoá đơn | ⚠️ toast "Chưa cấu hình máy in cho loại in này" — đã hiện thông báo thay vì im lặng (cải thiện so với phiên trước); chưa có máy in thật nên không kiểm chứng được phần cứng |

Ghi chú dữ liệu: `order_payment` **không có trường `order`** — liên kết nằm một chiều ở `order.payments[]`. Truy vấn báo cáo phải đi từ phía order.

### 2.3 Quản lý — tạo cấu hình còn thiếu (để test được giảm giá/thẻ)

| Chức năng | Thao tác | Kết quả |
|---|---|---|
| Loại thanh toán | tạo "The ngan hang", Loại = **Thẻ**, Ưu tiên 2 | ✅ toast "Đã lưu loại thanh toán The ngan hang", bảng 2 dòng (Tiền mặt, Thẻ) |
| Giảm giá | tạo "Giam 10 phan tram": Phạm vi **Giỏ hàng**, Chế độ **Thủ công**, Loại **Phần trăm**, Tối thiểu % = Tối đa % = 10, Ưu tiên 1 | ✅ toast "Đã lưu chiết khấu …", bảng 1 dòng; form đổi nhãn theo Loại/Phạm vi đúng |
| Mã giảm giá | tạo **GIAM20K**: Loại mã = order, Loại giảm = fixed, Giá trị giảm 20.000, đơn tối thiểu 0, Ưu tiên 1 | ✅ toast "Đã lưu phiếu giảm giá GIAM20K", hàng hiện `… 1 Có` (hoạt động) |

## 3. Lỗi phát hiện thêm ở vòng 2

**R2-1 (Medium, còn nguyên từ Lỗi #7 phiên trước): giỏ và màn thanh toán báo tổng khác nhau.**
Giỏ hiện "Tổng cộng gồm VAT 10% ₫132.000" (đã nhân thuế) nhưng dialog thanh toán mặc định **"Không thuế"**, Thuế ₫0, tổng ₫125.000. Thu ngân không bấm "VAT (10%)" thì bán thiếu thuế, và hai màn hình mâu thuẫn nhau. Bằng chứng: cùng một đơn, giỏ ₫132.000 vs thanh toán ₫125.000 trước khi áp thuế.

**R2-2 (Medium, i18n): dropdown và bảng Mã giảm giá hiện enum thô.**
"Loại giảm giá" → `fixed` / `percent`; "Loại mã giảm giá" → `order` / `product` / `shipping`. Bảng danh sách cũng hiện `order fixed`. Tiếng Việt nhưng giá trị lựa chọn là tiếng Anh kỹ thuật.

**R2-3 (Low, dấu vết tính năng đã gỡ): tuỳ chọn `shipping` vẫn còn trong loại mã giảm giá.**
Delivery đã bị gỡ end-to-end (commit `416ab2e`) nhưng coupon kind vẫn mời gọi `shipping` — chọn vào sẽ tạo mã giảm giá cho một tính năng không còn tồn tại.

**R2-4 (Low, React): form Giảm giá / Mã giảm giá phát warning "changing an uncontrolled input to be controlled".**
Xuất hiện ngay sau khi lưu; không vỡ UI nhưng là lỗi code thật (value undefined → defined).

**R2-5 (đã khắc phục, ghi nhận để đối chiếu): lỗi máy in đã có toast.**
"No printers configured for this print type." trước đây chỉ nằm trong console; nay hiện toast tiếng Việt cho người dùng.

## 4. Chưa test trong vòng 2 (sẽ làm tiếp)

Phí phục vụ (cần cấu hình % trước); áp giảm giá + mã giảm giá vào đơn thật; thanh toán bằng **Thẻ** vừa tạo; huỷ/hoàn tiền/tách/gộp đơn/đổi bàn ở màn Đơn hàng; KDS đầy đủ; Cài đặt → lưu từng thẻ; Máy in / Cài đặt in; Đặt món qua QR tới cùng; Tồn kho (trả hàng NCC, công thức sản xuất, điều chuyển); Nhân sự (payroll, chấm công ra); Sổ sách (bút toán); Tích hợp (provider); "Hoàn tất chốt ngày" (cố ý chưa bấm — khoá kỳ bán hàng).

Các module `gift_cards`, `marketing`, `reservations`, `currencies`, `reorder`, `catalog_publish` **không có tab trong Quản lý** ở build này (19 tab: Món, Thực đơn, Nhóm món, Nhóm tuỳ chọn, Bàn, Đặt món qua QR, Khu vực, Giảm giá, Mã giảm giá, Bếp, Quy trình, Máy in, Cài đặt in, Loại đơn, Loại thanh toán, Phụ thu, Thuế, Người dùng, Cảnh báo bảo mật) → không có đường vào từ UI cho role Master.