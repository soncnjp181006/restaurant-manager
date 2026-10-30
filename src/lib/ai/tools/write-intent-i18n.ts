/**
 * Multilingual write-intent and entity keywords for assistant tool routing.
 * Matches verbs/terms from the supported UI locales (en, vi) — see
 * src/lib/languages.ts.
 *
 * Word boundaries use [^\p{L}] instead of \b because \b does not treat
 * accented Vietnamese letters as word characters. Diacritic-free spellings
 * are only accepted as multi-syllable compounds ("cap nhat", "giam gia"):
 * single-syllable forms without diacritics collide with English words
 * ("go", "bo", "tao") and would route read-only prompts to write tools.
 */

const WRITE_INTENT_VERBS = [
  // English
  "add", "create", "new", "update", "change", "modify", "set", "edit",
  "raise", "lower", "increase", "decrease", "rename", "assign", "attach", "hire", "import",
  "remove", "delete", "detach",
  // Vietnamese
  "thêm", "tạo", "tạo mới", "cập nhật", "cap nhat", "sửa", "chỉnh", "chỉnh sửa",
  "đổi", "làm mới", "gán", "phân công", "phan cong", "giao cho",
  "lưu", "nhập", "nhập kho", "nhap kho", "thuê", "nhận việc", "duyệt",
  "xoá", "huỷ", "hủy", "gỡ", "bỏ", "thêm vào", "đặt tên", "dat ten",
].join("|");

/** True when the prompt asks to create or update master data (any supported language). */
export const WRITE_INTENT_PATTERN = new RegExp(`(?:^|[^\\p{L}])(${WRITE_INTENT_VERBS})(?:[^\\p{L}]|$)`, "iu");

export const DISH_WRITE_KEYWORDS = new RegExp(
  `(?:^|[^\\p{L}])(${[
    "dish", "dishes", "menu item", "menu items",
    "món", "món ăn", "mon an", "thực đơn", "thuc don",
  ].join("|")})(?:[^\\p{L}]|$)`,
  "iu",
);

export const CATEGORY_WRITE_KEYWORDS = new RegExp(
  `(?:^|[^\\p{L}])(${[
    "categor(?:y|ies)", "group", "groups",
    "nhóm", "nhóm món", "nhom mon", "danh mục", "danh muc",
  ].join("|")})(?:[^\\p{L}]|$)`,
  "iu",
);

export const DISCOUNT_WRITE_KEYWORDS = new RegExp(
  `(?:^|[^\\p{L}])(${[
    "discount", "discounts", "promotion", "promotions", "coupon", "coupons",
    "giảm giá", "giam gia", "khuyến mãi", "khuyen mai", "triết khấu", "triet khau",
  ].join("|")})(?:[^\\p{L}]|$)|buy.?x.?get.?y|bxgy|buy \\d+ get \\d+`,
  "iu",
);

export const TABLE_WRITE_KEYWORDS = new RegExp(
  `(?:^|[^\\p{L}])(${[
    "table", "tables",
    "bàn", "khu vực", "khu vuc", "sơ đồ bàn",
  ].join("|")})(?:[^\\p{L}]|$)`,
  "iu",
);
