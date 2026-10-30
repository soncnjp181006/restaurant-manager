-- Seed global "Refund Print" settings when missing (copy from Final Print when available).
-- SurrealDB 3.x — applied via run-prod-migrations.cjs

LET $existing = (
  SELECT * FROM setting WHERE key = 'Refund Print' AND is_global = true LIMIT 1
);

IF array::len($existing) = 0 {
  LET $final = (
    SELECT * FROM setting WHERE key = 'Final Print' AND is_global = true LIMIT 1
  );
  IF array::len($final) > 0 {
    CREATE setting CONTENT {
      key: 'Refund Print',
      is_global: true,
      values: $final[0].values
    };
  } ELSE {
    CREATE setting CONTENT {
      key: 'Refund Print',
      is_global: true,
      values: {
        printMode: 'text',
        paperWidthMm: 80,
        rasterThreshold: 180
      }
    };
  };
};
