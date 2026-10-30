import {describe, expect, it} from "vitest";
import {
  DISH_WRITE_KEYWORDS,
  WRITE_INTENT_PATTERN,
} from "@/lib/ai/tools/write-intent-i18n.ts";
import {selectAssistantToolsForPrompt} from "@/lib/ai/tools/select-assistant-tools.ts";

describe("write-intent-i18n", () => {
  it("detects Vietnamese create/add verbs", () => {
    expect(WRITE_INTENT_PATTERN.test("thêm món Margherita mới giá 9.000đ")).toBe(true);
    expect(WRITE_INTENT_PATTERN.test("tạo nhóm mới")).toBe(true);
    expect(WRITE_INTENT_PATTERN.test("cập nhật giá bún bò")).toBe(true);
    expect(WRITE_INTENT_PATTERN.test("sửa thông tin bàn 12")).toBe(true);
    expect(WRITE_INTENT_PATTERN.test("xoá món trà đá")).toBe(true);
  });

  it("detects English create verbs", () => {
    expect(WRITE_INTENT_PATTERN.test("add a dish called Margherita")).toBe(true);
  });

  it("does not treat read-only prompts as write intent", () => {
    expect(WRITE_INTENT_PATTERN.test("cho xem doanh thu hôm nay")).toBe(false);
    expect(WRITE_INTENT_PATTERN.test("báo cáo bán hàng tuần trước")).toBe(false);
    expect(WRITE_INTENT_PATTERN.test("liệt kê các nhóm món")).toBe(false);
    expect(WRITE_INTENT_PATTERN.test("show me today's sales")).toBe(false);
  });

  it("no longer routes write tools for languages the app dropped", () => {
    // Supported while the app shipped tr/de/es/ru locale bundles.
    expect(WRITE_INTENT_PATTERN.test("9 TL'ye yeni Margherita yemeği ekle")).toBe(false);
    expect(WRITE_INTENT_PATTERN.test("yeni kategori oluştur")).toBe(false);
    expect(WRITE_INTENT_PATTERN.test("neues Gericht hinzufügen")).toBe(false);
    expect(WRITE_INTENT_PATTERN.test("añadir un plato nuevo")).toBe(false);
    expect(WRITE_INTENT_PATTERN.test("добавить блюдо")).toBe(false);
  });

  it("matches Vietnamese dish terms", () => {
    expect(DISH_WRITE_KEYWORDS.test("món Bún bò")).toBe(true);
    expect(DISH_WRITE_KEYWORDS.test("thêm vào thực đơn")).toBe(true);
    expect(DISH_WRITE_KEYWORDS.test("add the Margherita dish")).toBe(true);
  });
});

describe("selectAssistantToolsForPrompt Vietnamese writes", () => {
  const writeToolNames = (prompt: string, allowedModules: string[] = []) =>
    selectAssistantToolsForPrompt(prompt, allowedModules, {compact: true}).writeTools.map(t => t.function.name);

  it("includes propose_create_dishes for Vietnamese add-dish prompt when permitted", () => {
    const names = writeToolNames(
      "thêm món Margherita mới giá 9.000đ",
      ["admin.dishes.create"],
    );
    expect(names).toContain("propose_create_dishes");
  });

  it("keeps read-only Vietnamese prompts off the write path", () => {
    const names = writeToolNames(
      "cho xem doanh thu hôm nay",
      ["admin.dishes.create"],
    );
    expect(names).not.toContain("propose_create_dishes");
  });
});
