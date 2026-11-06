import { describe, expect, it } from "vitest";
import { EXCLUDE_QR_ORDERS_SQL, ONLY_QR_ORDERS_SQL, QR_ORDER_TAG } from "../self-order-closing.ts";

/**
 * The MySQL data service (dbproxy) parses a subset of SurrealQL. `NOTINSIDE`
 * is outside that subset, and when the closing screen's query died on it the
 * page swallowed the error and showed ₫0 for a cycle that had real takings —
 * i.e. a day could be closed against zero revenue. These fragments are the
 * app's only window into which orders are QR self-orders, so they are pinned.
 */
describe("closing SQL fragments stay parseable by the data service", () => {
  it("does not use operators the proxy cannot parse", () => {
    for (const sql of [EXCLUDE_QR_ORDERS_SQL, ONLY_QR_ORDERS_SQL]) {
      expect(sql).not.toMatch(/NOTINSIDE/i);
      expect(sql).not.toMatch(/\bINSIDE\b/i);
      expect(sql).not.toMatch(/->/);
    }
  });

  it("expresses the exclusion as a negated CONTAINS over the tag list", () => {
    expect(EXCLUDE_QR_ORDERS_SQL).toBe(`AND NOT ((tags ?? []) CONTAINS '${QR_ORDER_TAG}')`);
    expect(ONLY_QR_ORDERS_SQL).toBe(`AND (tags ?? []) CONTAINS '${QR_ORDER_TAG}'`);
  });

  it("keeps both fragments as AND clauses on the same predicate", () => {
    // A closing that excluded QR orders and a QR report that only counted them
    // must partition the same set — anything else double-counts or drops money.
    expect(EXCLUDE_QR_ORDERS_SQL.startsWith("AND ") && ONLY_QR_ORDERS_SQL.startsWith("AND ")).toBe(true);
    expect(EXCLUDE_QR_ORDERS_SQL).toContain(`(tags ?? []) CONTAINS '${QR_ORDER_TAG}'`);
    expect(ONLY_QR_ORDERS_SQL).toContain(`(tags ?? []) CONTAINS '${QR_ORDER_TAG}'`);
    expect(EXCLUDE_QR_ORDERS_SQL).toContain("NOT ");
  });
});
