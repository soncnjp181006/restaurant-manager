# `migrations/relational` — chuyển 167 bảng nghiệp vụ sang bảng MySQL thật

Bộ công cụ biến cấu trúc trong `migrations/latest.surql` + dữ liệu trong bảng `records`
thành các bảng MySQL quan hệ có kiểu cột và khóa ngoại thật (không có cột `JSON`).

| File | Vai trò |
|---|---|
| `lib.mjs` | Parser `DEFINE TABLE/FIELD/INDEX`, dựng model, render DDL, encode/decode giá trị lồng nhau |
| `generate.mjs` | Sinh `001_tables.sql`, `002_foreign_keys.sql`, `report.json`, `docs/erd/relational.mmd` |
| `import.mjs` | Tạo DB đích, nạp dữ liệu, thêm FK, đối chiếu **từng giá trị** với JSON nguồn |
| `001_tables.sql` | 167 bảng cha + 71 bảng mảng + 40 bảng thuộc tính |
| `002_foreign_keys.sql` | 495 khóa ngoại (nạp sau dữ liệu) |
| `report.json` | Số dòng/cột/FK từng bảng, danh sách ràng buộc bị bỏ qua |

```bash
# sinh lại DDL sau khi có migration mới hoặc dữ liệu thay đổi
DB_HOST=127.0.0.1 DB_PORT=3307 DB_USER=restaurant DB_PASS=... \
  node migrations/relational/generate.mjs

# nạp vào database đích (mặc định restaurant_manager_relational)
DB_PASS=... DB_NAME=restaurant_manager MYSQL_ROOT_PASSWORD=... \
  node migrations/relational/import.mjs --reset

# chỉ kiểm tra lại
DB_PASS=... node migrations/relational/import.mjs --verify-only
```

Chi tiết quy tắc ánh xạ, ngoại lệ dữ liệu và kế hoạch cutover: [`docs/RELATIONAL-MYSQL.md`](../../docs/RELATIONAL-MYSQL.md).

> Lưu ý: đây là bản sao quan hệ đã kiểm chứng. `dbproxy` vẫn đang đọc/ghi `records`
> cho tới bước cutover (xem §7 của tài liệu trên).
