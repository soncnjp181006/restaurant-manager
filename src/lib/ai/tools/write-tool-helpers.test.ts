import {describe, expect, it, vi} from "vitest";
import {
  buildWriteToolDefinitionsFromFields,
  createMergeUpdatePatchesByMatchFields,
} from "@/lib/ai/tools/write-tool-helpers.ts";
import type {ImportDbLike} from "@/lib/data-import/types.ts";
import type {OpenAIToolDefinition} from "@/lib/openai.service.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** `function.parameters` is a JSON-schema bag typed `Record<string, unknown>`,
 *  so each level is walked with a runtime check instead of an `as any` hop. */
const requiredFieldsOf = (
  tool: OpenAIToolDefinition | undefined,
  recordsArgKey: string,
): string[] => {
  const properties = tool?.function.parameters.properties;
  if (!isRecord(properties)) return [];
  const records = properties[recordsArgKey];
  if (!isRecord(records)) return [];
  const items = records.items;
  if (!isRecord(items)) return [];
  return Array.isArray(items.required)
    ? items.required.filter((entry): entry is string => typeof entry === "string")
    : [];
};

describe("buildWriteToolDefinitionsFromFields", () => {
  it("builds create and update tools with required fields", () => {
    const tools = buildWriteToolDefinitionsFromFields({
      entityLabel: "Category",
      recordsArgKey: "categories",
      createToolName: "propose_create_categories",
      updateToolName: "propose_update_categories",
      matchFields: ["name"],
      fields: [
        {name: "name", type: "string", requiredOnCreate: true},
        {name: "priority", type: "number"},
      ],
    });

    expect(tools).toHaveLength(2);
    expect(tools[0].function.name).toBe("propose_create_categories");
    expect(tools[1].function.name).toBe("propose_update_categories");

    expect(requiredFieldsOf(tools[0], "categories")).toContain("name");

    expect(requiredFieldsOf(tools[1], "categories")).toContain("name");
  });

  it("returns only create tool when updateToolName is omitted", () => {
    const tools = buildWriteToolDefinitionsFromFields({
      entityLabel: "Print setting",
      recordsArgKey: "print_settings",
      createToolName: "propose_update_print_settings",
      matchFields: ["key"],
      fields: [{name: "key", type: "string", requiredOnCreate: true}],
    });

    expect(tools).toHaveLength(1);
    expect(tools[0].function.name).toBe("propose_update_print_settings");
    expect(tools.every(tool => Boolean(tool.function.name))).toBe(true);
  });
});

describe("createMergeUpdatePatchesByMatchFields", () => {
  it("merges existing row values into update patches", async () => {
    const merge = createMergeUpdatePatchesByMatchFields("categories", ["name"], {softDelete: false});
    const db: ImportDbLike = {
      query: vi.fn(async () => [[{name: "Pizza", priority: 5, show_in_menu: true}]]),
    };

    const merged = await merge(db, [{name: "Pizza", priority: 10}]);
    expect(merged[0]).toEqual({name: "Pizza", priority: 10, show_in_menu: true});
  });

  it("returns patch unchanged when no match row exists", async () => {
    const merge = createMergeUpdatePatchesByMatchFields("categories", ["name"], {softDelete: false});
    const db: ImportDbLike = {
      query: vi.fn(async () => [[]]),
    };

    const merged = await merge(db, [{name: "Missing", priority: 1}]);
    expect(merged[0]).toEqual({name: "Missing", priority: 1});
  });
});
