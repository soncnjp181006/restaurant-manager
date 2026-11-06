import {Tables} from "@/api/db/tables.ts";
import type {ImportConfiguration, ImportDbLike, ImportField, ImportRecord} from "@/lib/data-import/types.ts";
import {type TFunc} from "@/lib/data-import/helpers.ts";
import {toRecordId} from "@/lib/utils.ts";

const unwrapRows = <T>(result: unknown): T[] => {
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0] as T[];
  return [];
};

const PRINT_SETTING_KEYS = [
  "Temp Print",
  "Final Print",
  "Kitchen Print",
  "Summary Print",
] as const;

export function createPrintSettingsImportConfig({db, t}: {db: ImportDbLike; t: TFunc}): ImportConfiguration {
  const fields: ImportField[] = [
    {name: "key", label: t("admin:columns.name"), type: "string", required: true},
    {name: "top_margin", label: t("admin:forms.topMargin"), type: "number", optional: true},
    {name: "bottom_margin", label: t("admin:forms.bottomMargin"), type: "number", optional: true},
    {name: "left_margin", label: t("admin:forms.leftMargin"), type: "number", optional: true},
    {name: "right_margin", label: t("admin:forms.rightMargin"), type: "number", optional: true},
    {name: "show_logo", label: t("admin:forms.showLogo"), type: "boolean", optional: true},
    {name: "logoOffsetX", label: t("admin:forms.logoOffsetX"), type: "number", optional: true},
    {name: "show_vat_number", label: t("admin:forms.showVatNumber"), type: "boolean", optional: true},
    {name: "vat_name", label: t("admin:forms.vatName"), type: "string", optional: true},
    {name: "vat_number", label: t("admin:forms.vatNumber"), type: "string", optional: true},
  ];

  return {
    id: "print_settings",
    entityLabel: t("admin:tabs.printSettings", {defaultValue: "Print settings"}),
    shape: "records",
    fields,
    matchFields: ["key"],
    defaultMode: "update",
    db,
    extractionInstructions: "Update print settings by key (Temp Print, Final Print, Kitchen Print, Summary Print).",
    onImportRow: async (record: ImportRecord) => {
      const key = String(record.values.key ?? "").trim();
      if (!key) throw new Error(t("validation:required"));
      if (!PRINT_SETTING_KEYS.includes(key as typeof PRINT_SETTING_KEYS[number])) {
        throw new Error(`Unknown print setting key: ${key}`);
      }

      const rows = unwrapRows<{id: unknown; values?: Record<string, unknown>}>(
        await db.query(
          `SELECT id, values FROM ${Tables.settings} WHERE key = $key LIMIT 1`,
          {key},
        ),
      );
      if (!rows[0]?.id) throw new Error(t("common:csvImport.recordNotFound"));

      const current = rows[0].values ?? {};
      const patch: Record<string, unknown> = {...current};
      for (const field of fields) {
        if (field.name === "key") continue;
        if (record.values[field.name] !== undefined && record.values[field.name] !== null && record.values[field.name] !== "") {
          patch[field.name] = record.values[field.name];
        }
      }

      await db.merge?.(rows[0].id, {values: patch});
    },
  };
}
