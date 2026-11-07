/**
 * Relational MySQL model for the Restaurant Manager data.
 *
 * Source of truth for structure: migrations/latest.surql (DEFINE TABLE /
 * DEFINE FIELD / DEFINE INDEX). Source of truth for column presence, sizes,
 * nullability and referential integrity: the rows currently stored in
 * `records` (they reveal the shapes of SCHEMALESS tables and whether a
 * declared reference actually resolves).
 *
 * Output: one real MySQL table per business table (`id` = record key), a child
 * table per array field, an extras table per table that has nested/undeclared
 * object data, real UNIQUE keys, and real FOREIGN KEY constraints. No column
 * stores JSON.
 */

import fs from 'node:fs';

export const MAX_IDENT = 64;

export function quoteIdent(name) {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

function stripTicks(s) {
  return String(s).replace(/^`(.*)`$/, '$1');
}

function shortHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(0, 8);
}

/** Deterministic identifier that always fits MySQL's 64-char limit. */
export function fitIdent(name) {
  if (name.length <= MAX_IDENT) return name;
  return `${name.slice(0, MAX_IDENT - 9)}_${shortHash(name)}`;
}

const KEYWORDS = / (?:DEFAULT|VALUE|ASSERT|PERMISSIONS|READONLY|COMMENT|REFERENCE)\b/;

/** Parse `migrations/latest.surql` into tables/fields/indexes. */
export function parseSchema(text) {
  const tables = new Map();
  const indexes = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('DEFINE ')) continue;

    if (line.startsWith('DEFINE TABLE ')) {
      const m = line.match(/^DEFINE TABLE (`[^`]+`|\S+) TYPE (\w+) (\w+)/);
      if (!m) continue;
      const name = stripTicks(m[1]);
      tables.set(name, { name, mode: m[3], fields: [], indexes: [] });
      continue;
    }

    if (line.startsWith('DEFINE FIELD ')) {
      const m = line.match(/^DEFINE FIELD (`[^`]+`|\S+) ON (\S+) (.*)$/);
      if (!m) continue;
      const fieldName = stripTicks(m[1]);
      const tableName = stripTicks(m[2]);
      let rest = m[3].replace(/;$/, '');
      let type = null;
      let def = null;

      if (/^TYPE\b/.test(rest)) {
        const afterType = rest.replace(/^TYPE\s*/, '');
        const parts = afterType.split(KEYWORDS);
        type = parts[0].trim();
        const defMatch = afterType.match(/ DEFAULT (.*)$/);
        if (defMatch) def = defMatch[1].split(KEYWORDS)[0].trim();
      } else if ((def = rest.match(/DEFAULT (.*)$/)?.[1]?.split(KEYWORDS)[0]?.trim()) === undefined) {
        def = null;
      }

      const table = tables.get(tableName);
      if (!table) continue;
      table.fields.push({ name: fieldName, type, default: def });
      continue;
    }

    if (line.startsWith('DEFINE INDEX ')) {
      const m = line.match(/^DEFINE INDEX (`[^`]+`|\S+) ON (\S+) FIELDS (.+?)( UNIQUE)?(?: (?:COMMENT|PERMISSIONS|CONCURRENTLY|IF NOT EXISTS)\b.*)?;?$/);
      if (!m) continue;
      const fields = m[3]
        .split(',')
        .map((f) => stripTicks(f.trim().split(/\s+/)[0]))
        .filter(Boolean);
      indexes.push({
        name: stripTicks(m[1]),
        table: stripTicks(m[2]),
        fields,
        unique: Boolean(m[4]),
      });
    }
  }

  for (const index of indexes) {
    const table = tables.get(index.table);
    if (table) table.indexes.push(index);
  }

  return { tables, indexes };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

function isIsoDate(s) {
  return typeof s === 'string' && ISO_DATE.test(s) && !Number.isNaN(Date.parse(s));
}

function isScalar(v) {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function isRefString(v) {
  return typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]*:.+$/s.test(v);
}

function splitRef(v) {
  const m = String(v).match(/^([A-Za-z_][A-Za-z0-9_]*):(.+)$/s);
  return m ? { table: m[1], key: m[2] } : null;
}

/** Parse a Surreal type expression into a coarse descriptor. */
export function parseType(typeText) {
  if (!typeText) return { base: 'any', nullable: true };
  const parts = typeText.split('|').map((p) => p.trim()).filter(Boolean);
  const nullable = parts.some((p) => p === 'none' || p === 'null');
  const concrete = parts.filter((p) => p !== 'none' && p !== 'null');
  const base = concrete[0] ?? 'any';

  if (base === 'any') return { base: 'any', nullable };
  const rec = base.match(/^record<([A-Za-z_][A-Za-z0-9_]*)>$/);
  if (rec) return { base: 'ref', refTable: rec[1], nullable };
  const arr = base.match(/^array<(.+)>$/);
  if (arr) {
    const inner = arr[1].trim();
    const recInner = inner.match(/^record<([A-Za-z_][A-Za-z0-9_]*)>$/);
    if (recInner) return { base: 'array', item: 'ref', refTable: recInner[1], nullable };
    if (inner === 'string') return { base: 'array', item: 'string', nullable };
    if (inner === 'int') return { base: 'array', item: 'int', nullable };
    if (inner === 'float' || inner === 'number') return { base: 'array', item: 'float', nullable };
    if (inner === 'bool') return { base: 'array', item: 'bool', nullable };
    return { base: 'array', item: 'any', nullable };
  }
  if (base === 'object') return { base: 'object', nullable };
  if (base === 'string' || base === 'uuid' || base === 'duration') return { base: 'string', nullable };
  if (base === 'int') return { base: 'int', nullable };
  if (base === 'float' || base === 'number') return { base: 'float', nullable };
  if (base === 'decimal') return { base: 'float', nullable };
  if (base === 'bool') return { base: 'bool', nullable };
  if (base === 'datetime') return { base: 'datetime', nullable };
  if (base === 'bytes') return { base: 'bytes', nullable };
  return { base: 'any', nullable };
}

function inferSqlType(values, uniqueColumn) {
  const list = values.filter((v) => v !== null && v !== undefined);
  if (list.length === 0) return 'text';
  if (list.every((v) => typeof v === 'boolean')) return 'tinyint(1)';
  if (list.every((v) => typeof v === 'number')) {
    return list.every((v) => Number.isInteger(v)) ? 'bigint' : 'double';
  }
  if (list.every((v) => isIsoDate(v))) return 'datetime(3)';
  const maxLen = Math.max(...list.map((v) => String(v).length));
  if (maxLen > 500 || uniqueColumn) return 'text';
  const size = maxLen <= 64 ? 64 : maxLen <= 128 ? 128 : maxLen <= 255 ? 255 : 500;
  return `varchar(${size})`;
}

function columnFor(base, values) {
  const nonNull = values.filter((v) => v !== null && v !== undefined);
  if (nonNull.length === 0) {
    // Empty table: fall back to the declared type so the column is usable.
    switch (base) {
      case 'string':
        return 'varchar(255)';
      case 'int':
        return 'bigint';
      case 'float':
        return 'double';
      case 'bool':
        return 'tinyint(1)';
      case 'datetime':
        return 'datetime(3)';
      case 'bytes':
        return 'longblob';
      default:
        return 'text';
    }
  }
  switch (base) {
    case 'string':
      return inferSqlType(values, false);
    case 'int': {
      const numbers = values.filter((v) => typeof v === 'number');
      return numbers.some((v) => !Number.isInteger(v)) ? 'double' : 'bigint';
    }
    case 'float':
      return 'double';
    case 'bool':
      return 'tinyint(1)';
    case 'datetime':
      return 'datetime(3)';
    case 'bytes':
      return 'longblob';
    default:
      return inferSqlType(values, false);
  }
}

function defaultSql(expr, sqlType) {
  if (!expr) return null;
  if (/^time::now\(\)$/i.test(expr)) return 'CURRENT_TIMESTAMP(3)';
  if (/^(true|false)$/i.test(expr)) return expr.toLowerCase() === 'true' ? '1' : '0';
  if (/^-?\d+(?:\.\d+)?$/.test(expr)) return expr;
  const str = expr.match(/^'([^']*)'$/);
  if (str) return `'${str[1].replace(/'/g, "''")}'`;
  return null;
}

/** Collect every non-null value seen for `path` across rows. */
function observedValues(rows, path) {
  const out = [];
  let present = 0;
  for (const row of rows) {
    const v = row.data?.[path];
    if (v === undefined) continue;
    present += 1;
    out.push(v);
  }
  return { values: out, present };
}

/** Build the relational model from the parsed schema + live records. */
export function buildModel(schema, rowsByTable) {
  const model = [];
  const warnings = [];
  const idsByTable = new Map();
  for (const [table, rows] of rowsByTable) {
    idsByTable.set(table, new Set(rows.map((r) => r.id)));
  }

  for (const [tableName, table] of schema.tables) {
    const rows = rowsByTable.get(tableName) ?? [];
    const declared = new Map();
    for (const field of table.fields) {
      if (field.name.includes('.') || field.name.includes('*')) continue;
      declared.set(field.name, field);
    }

    const columns = [];
    const arrays = [];
    const extrasFields = [];
    const used = new Set();
    const observedKeys = new Set();
    for (const row of rows) for (const key of Object.keys(row.data ?? {})) observedKeys.add(key);

    const candidates = [...declared.keys()];
    for (const key of observedKeys) if (!declared.has(key)) candidates.push(key);

    for (const fieldName of candidates) {
      if (fieldName === 'id') {
        // The record key already is the primary key `id`.
        warnings.push(`${tableName}.id duplicates the record key and is stored as the primary key`);
        continue;
      }
      const field = declared.get(fieldName) ?? null;
      const { values, present } = observedValues(rows, fieldName);
      used.add(fieldName);
      const nonNull = values.filter((v) => v !== null);
      const allScalar = nonNull.every(isScalar);
      const typeInfo = field ? parseType(field.type) : null;

      // Undeclared field that holds record links whose table is the field name
      // (e.g. order_item.menu_item was written by older clients): a real FK.
      if (!field && nonNull.length > 0 && nonNull.every(isRefString)) {
        const targets = new Set(nonNull.map((v) => splitRef(v).table));
        const target = targets.size === 1 ? [...targets][0] : null;
        if (target && target === fieldName && idsByTable.has(target)) {
          const orphans = new Set(
            nonNull.filter((v) => !idsByTable.get(splitRef(v).table)?.has(splitRef(v).key))
          );
          columns.push({
            field: fieldName,
            sql: 'varchar(512)',
            maxLength: 512,
            kind: 'ref',
            refTable: target,
            // Link columns stay nullable: clients write the canonical link on the
            // parent array (order.payments, …) and omit the back-reference.
            nullable: true,
            default: null,
            orphans: [...orphans],
          });
          continue;
        }
      }

      // Declared arrays are always materialised as child tables, even empty.
      if (typeInfo?.base === 'array') {
        let item = typeInfo.item;
        let refTable = typeInfo.refTable ?? null;
        let orphanCount = 0;
        const items = nonNull.flat().filter((v) => v !== null && v !== undefined);
        if (item === 'ref' && items.length > 0) {
          if (!items.every(isRefString)) {
            item = 'string';
            refTable = null;
            warnings.push(`${tableName}.${fieldName} is declared array<record<${typeInfo.refTable}>> but holds plain values`);
          } else {
            orphanCount = items.filter((v) => !idsByTable.get(splitRef(v).table)?.has(splitRef(v).key)).length;
            if (orphanCount > 0) warnings.push(`${tableName}.${fieldName} holds ${orphanCount} dangling reference(s)`);
          }
        }
        arrays.push({
          field: fieldName,
          item,
          refTable,
          nullable: typeInfo.nullable || present < rows.length,
          declared: true,
          orphanCount,
        });
        continue;
      }

      if (typeInfo?.base === 'ref') {
        // Some callers wrote plain values (e.g. a tax amount) into a field the
        // schema declares as a record link. Keep that data verbatim in extras
        // rather than pretending it is a foreign key.
        if (nonNull.length > 0 && !nonNull.every(isRefString)) {
          extrasFields.push(fieldName);
          warnings.push(`${tableName}.${fieldName} is declared record<${typeInfo.refTable}> but holds non-reference values`);
          continue;
        }
        const orphans = new Set();
        for (const v of nonNull) {
          const ref = splitRef(v);
          if (!ref || !(idsByTable.get(ref.table)?.has(ref.key))) orphans.add(String(v));
        }
        columns.push({
          field: fieldName,
          sql: 'varchar(512)',
          maxLength: 512,            kind: 'ref',
            refTable: typeInfo.refTable,
            // See above: FK columns must stay nullable so document-style writes
            // that rely on the parent array do not fail on a NOT NULL back-ref.
            nullable: true,
          default: defaultSql(field.default, 'varchar(512)'),
          orphans: [...orphans],
        });
        continue;
      }

      // Arrays/metadata discovered only from data (declared as any or not declared).
      if (nonNull.length > 0 && !allScalar) {
        if (nonNull.every((v) => Array.isArray(v))) {
          const items = nonNull.flat().filter((v) => v !== null && v !== undefined);
          const allStrings = items.every((v) => typeof v === 'string');
          const allRefs = allStrings && items.length > 0 && items.every(isRefString);
          if (allRefs) {
            const targets = new Set(items.map((v) => splitRef(v).table));
            const target = targets.size === 1 ? [...targets][0] : null;
            const orphans = items.filter((v) => !idsByTable.get(splitRef(v).table)?.has(splitRef(v).key));
            for (const orphan of new Set(orphans)) {
              warnings.push(`${tableName}.${fieldName} holds dangling reference ${orphan}`);
            }
            columns.push({ field: fieldName, sql: null, kind: 'skip-array-ref' });
            arrays.push({
              field: fieldName,
              item: target ? 'ref' : 'string',
              refTable: target,
              nullable: true,
              declared: Boolean(field),
              orphanCount: new Set(orphans).size,
            });
            continue;
          }
          if (allStrings) {
            columns.push({ field: fieldName, sql: null, kind: 'skip-array' });
            arrays.push({ field: fieldName, item: 'string', refTable: null, nullable: true, declared: Boolean(field) });
            continue;
          }
        }
        extrasFields.push(fieldName);
        continue;
      }

      if (typeInfo?.base === 'object') {
        extrasFields.push(fieldName);
        continue;
      }

      if (!field && (typeInfo === null)) {
        // observed scalar field on a SCHEMALESS table
      }

      if (typeInfo?.base === 'any' || !field) {
        if (nonNull.length === 0) {
          // Unknown shape and no data yet — keep it out of the typed columns.
          if (present > 0) columns.push({ field: fieldName, sql: 'text', kind: 'scalar', nullable: true });
          else extrasFields.push(fieldName);
          continue;
        }
      }

      const sqlType = columnFor(typeInfo?.base ?? 'any', nonNull);
      const nullable =
        !field || typeInfo?.nullable !== false || present < rows.length || nonNull.length !== values.length;
      columns.push({
        field: fieldName,
        sql: sqlType,
        maxLength: nonNull.length ? Math.max(...nonNull.map((v) => String(v).length)) : 0,
        kind: 'scalar',
        nullable,
        default: field ? defaultSql(field.default, sqlType) : null,
      });
    }

    // Unique / plain indexes that map to real columns of this table.
    const columnNames = new Set(columns.filter((c) => c.kind !== 'skip-array-ref' && c.kind !== 'skip-array').map((c) => c.field));
    const indexes = [];
    for (const index of table.indexes) {
      if (!index.fields.every((f) => columnNames.has(f))) {
        warnings.push(`skip index ${index.name} on ${tableName}: fields ${index.fields.join(', ')} are not plain columns`);
        continue;
      }
      const unindexable = index.fields.find((f) => {
        const column = columns.find((c) => c.field === f);
        return column && (column.sql === 'text' || column.sql === 'longblob');
      });
      if (unindexable) {
        warnings.push(`skip index ${index.name} on ${tableName}: ${unindexable} is longer than 500 chars`);
        continue;
      }
      if (index.unique) {
        const seen = new Set();
        let duplicate = null;
        for (const row of rows) {
          const values = index.fields.map((f) => row.data?.[f]);
          // SurrealDB (and the dbproxy) treat a missing/NONE component as
          // non-conflicting, so NULLs are skipped here too.
          if (values.some((v) => v === undefined || v === null)) continue;
          const key = values.map((v) => JSON.stringify(v)).join('\u0000');
          if (seen.has(key)) {
            duplicate = key;
            break;
          }
          seen.add(key);
        }
        if (duplicate !== null) {
          warnings.push(`skip UNIQUE ${index.name} on ${tableName}: duplicate value in current data`);
          continue;
        }
      }
      indexes.push({ ...index, ident: fitIdent(`${tableName}_${index.name}`) });
    }

    // A column used by any index must be a VARCHAR, never TEXT/BLOB. Any
    // other string is TEXT so user input (notes, user agents, names) can
    // never overflow a size that was guessed from the sample rows.
    const indexedFields = new Set(table.indexes.flatMap((i) => i.fields));
    for (const column of columns) {
      if (column.kind !== 'scalar') continue;
      if (indexedFields.has(column.field)) {
        if (column.sql === 'text' && (column.maxLength ?? 0) <= 500) column.sql = 'varchar(500)';
        else if (/^varchar\(/.test(column.sql) && (column.maxLength ?? 0) > 500) column.sql = 'varchar(500)';
      } else if (/^varchar\(/.test(column.sql)) {
        column.sql = 'text';
        // MySQL 8 does not allow literal defaults on TEXT columns.
        column.default = null;
      }
    }

    model.push({
      name: tableName,
      mode: table.mode,
      rowCount: rows.length,
      columns: columns.filter((c) => c.kind !== 'skip-array-ref' && c.kind !== 'skip-array'),
      arrays,
      extras: extrasFields.length > 0,
      extrasFields,
      indexes,
    });
  }

  // Foreign keys: only when every existing value resolves (integrity proven).
  for (const table of model) {
    table.foreignKeys = [];
    for (const column of table.columns) {
      if (column.kind !== 'ref') continue;
      const target = model.find((t) => t.name === column.refTable);
      if (!target) {
        warnings.push(`skip FK ${table.name}.${column.field}: unknown table ${column.refTable}`);
        continue;
      }
      if (column.orphans?.length) {
        warnings.push(
          `skip FK ${table.name}.${column.field} -> ${column.refTable}: ${column.orphans.length} dangling reference(s)`
        );
        continue;
      }
      table.foreignKeys.push({
        name: fitIdent(`${table.name}_${column.field}_fk`),
        column: column.field,
        refTable: column.refTable,
        onDelete: column.nullable ? 'SET NULL' : 'RESTRICT',
      });
    }
    for (const array of table.arrays) {
      if (array.item !== 'ref' || !array.refTable) continue;
      const target = model.find((t) => t.name === array.refTable);
      if (!target) continue;
      if (array.orphanCount > 0) {
        warnings.push(`skip FK ${table.name}__${array.field}.ref_id -> ${array.refTable}: dangling references`);
        continue;
      }
      table.foreignKeys.push({
        name: fitIdent(`${table.name}_${array.field}_ref_fk`),
        childTable: childTableName(table.name, array.field),
        childColumn: 'ref_id',
        refTable: array.refTable,
        onDelete: 'SET NULL',
      });
    }
  }

  return { model, warnings };
}

export function childTableName(table, field) {
  return fitIdent(`${table}__${field}`);
}

/** Key/value table that holds nested or schemaless values (no JSON columns). */
export function attrsTableName(table) {
  return fitIdent(`${table}__attrs`);
}

const COMMON_TAIL = `  \`row_created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  \`row_updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),`;

function columnDdl(column) {
  const parts = [quoteIdent(column.field), column.sql];
  if (column.sql === 'text' || column.sql === 'longblob' || column.sql.startsWith('varchar')) {
    if (column.sql.startsWith('varchar') || column.sql === 'text') parts.push('COLLATE utf8mb4_bin');
  }
  // The app writes document-shaped records (partial payloads, the canonical
  // link kept on the parent array), so only `id` is mandatory at the DB level;
  // integrity comes from PRIMARY/FOREIGN/UNIQUE keys, not from NOT NULL.
  parts.push('NULL');
  if (column.default != null) parts.push(`DEFAULT ${column.default}`);
  return '  ' + parts.join(' ');
}

/** Render the CREATE TABLE statements (no foreign keys; see renderForeignKeys). */
export function renderTables(model) {
  const out = [];
  out.push('-- Generated by migrations/relational/generate.mjs — do not edit by hand.');
  out.push(`-- Physical relational layout for the ${model.length} business tables defined in migrations/latest.surql.`);
  out.push('-- InnoDB + utf8mb4_bin keeps record keys byte-exact (case/accent sensitive).');
  out.push('SET NAMES utf8mb4;');
  out.push('');

  for (const table of model) {
    const defs = [];
    defs.push(
      `  \`id\` varchar(512) COLLATE utf8mb4_bin NOT NULL COMMENT 'record key (table:id without prefix)'`
    );
    for (const column of table.columns) defs.push(columnDdl(column));
    defs.push(...COMMON_TAIL.split(',\n').map((line) => line.replace(/,$/, '')));
    defs.push('  PRIMARY KEY (`id`)');

    for (const index of table.indexes) {
      const cols = index.fields.map((f) => indexColumn(f, table, index.fields.length)).join(', ');
      defs.push(`  ${index.unique ? 'UNIQUE ' : ''}KEY ${quoteIdent(index.ident)} (${cols})`);
    }
    // Index the FK columns so MySQL can enforce the constraints efficiently;
    // skip it when a declared index already starts with the same column.
    for (const column of table.columns) {
      if (column.kind !== 'ref') continue;
      const covered = table.indexes.some((i) => i.fields[0] === column.field);
      if (covered) continue;
      defs.push(`  KEY ${quoteIdent(fitIdent(`${table.name}_${column.field}_idx`))} (${quoteIdent(column.field)})`);
    }

    const body = defs.map((line, i) => (i === defs.length - 1 ? line : `${line},`)).join('\n');
    out.push(
      `CREATE TABLE ${quoteIdent(table.name)} (\n${body}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT=${quoteSql(
        `record table ${table.name} (${table.rowCount} rows at conversion)`.slice(0, 200)
      )};`
    );
    out.push('');

    for (const array of table.arrays) {
      const child = childTableName(table.name, array.field);
      const valueColumn =
        array.item === 'ref'
          ? '`ref_id` varchar(512) COLLATE utf8mb4_bin NULL'
          : array.item === 'int' || array.item === 'float'
            ? '`value_number` double NULL'
            : array.item === 'bool'
              ? '`value_bool` tinyint(1) NULL'
              : array.item === 'any'
                ? '`value_text` longtext COLLATE utf8mb4_bin NULL'
                : '`value_text` varchar(512) COLLATE utf8mb4_bin NULL';
      out.push(
        [
          `-- 1-n children of ${quoteIdent(table.name)}.${quoteIdent(array.field)} (order preserved by \`ord\`)`,
          `CREATE TABLE ${quoteIdent(child)} (`,
          `  \`parent_id\` varchar(512) COLLATE utf8mb4_bin NOT NULL,`,
          `  \`ord\` int NOT NULL,`,
          `  ${valueColumn},`,
          `  PRIMARY KEY (\`parent_id\`, \`ord\`),`,
          array.item === 'ref'
            ? `  KEY ${quoteIdent(fitIdent(`${child}_ref_idx`))} (\`ref_id\`),`
            : `  KEY ${quoteIdent(fitIdent(`${child}_parent_idx`))} (\`parent_id\`),`,
          `  CONSTRAINT ${quoteIdent(fitIdent(`${child}_parent_fk`))} FOREIGN KEY (\`parent_id\`) REFERENCES ${quoteIdent(table.name)} (\`id\`) ON DELETE CASCADE ON UPDATE CASCADE`,
          `) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;`,
        ].join('\n')
      );
      out.push('');
    }

    if (table.extras) {
      const child = attrsTableName(table.name);
      out.push(
        [
          `-- Nested / schemaless values of ${quoteIdent(table.name)} (path = dotted location, arrays use [index]).`,
          `-- Stored as typed key/value rows so no column has to hold JSON.`,
          `CREATE TABLE ${quoteIdent(child)} (`,
          `  \`parent_id\` varchar(512) COLLATE utf8mb4_bin NOT NULL,`,
          `  \`path\` varchar(255) COLLATE utf8mb4_bin NOT NULL,`,
          `  \`kind\` varchar(16) COLLATE utf8mb4_bin NOT NULL,`,
          `  \`value_text\` longtext COLLATE utf8mb4_bin NULL,`,
          `  \`value_number\` double NULL,`,
          `  \`value_bool\` tinyint(1) NULL,`,
          `  PRIMARY KEY (\`parent_id\`, \`path\`),`,
          `  CONSTRAINT ${quoteIdent(fitIdent(`${child}_parent_fk`))} FOREIGN KEY (\`parent_id\`) REFERENCES ${quoteIdent(table.name)} (\`id\`) ON DELETE CASCADE ON UPDATE CASCADE`,
          `) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;`,
        ].join('\n')
      );
      out.push('');
    }
  }

  return out.join('\n');
}

/**
 * Column expression for a secondary index. InnoDB caps an index at 3072 bytes
 * (utf8mb4 = 4 bytes/char), so wide VARCHAR columns get a prefix when a key has
 * several of them (e.g. UNIQUE(a, b) with two 500-char columns).
 */
function indexColumn(field, table, count) {
  const column = table.columns.find((c) => c.field === field);
  const quoted = quoteIdent(field);
  if (!column) return quoted;
  const match = column.sql.match(/^varchar\((\d+)\)$/i);
  if (!match) return quoted;
  const declared = Number(match[1]);
  const maxChars = Math.floor(3072 / 4 / Math.max(count, 1));
  const chars = Math.min(declared, Math.max(1, maxChars));
  return chars < declared ? `${quoted}(${chars})` : quoted;
}

function quoteSql(s) {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

/** Render ALTER TABLE ... ADD CONSTRAINT statements (applied after bulk load). */
export function renderForeignKeys(model) {
  const out = [];
  out.push('-- Generated by migrations/relational/generate.mjs — do not edit by hand.');
  out.push('-- Applied after the bulk load so cyclic references can be inserted first.');
  out.push('SET FOREIGN_KEY_CHECKS = 0;');
  out.push('');
  for (const table of model) {
    for (const fk of table.foreignKeys) {
      const childTable = fk.childTable ?? table.name;
      const childColumn = fk.childColumn ?? fk.column;
      out.push(
        `ALTER TABLE ${quoteIdent(childTable)} ADD CONSTRAINT ${quoteIdent(fk.name)} ` +
          `FOREIGN KEY (${quoteIdent(childColumn)}) REFERENCES ${quoteIdent(fk.refTable)} (\`id\`) ` +
          `ON DELETE ${fk.onDelete} ON UPDATE CASCADE;`
      );
    }
  }
  out.push('');
  out.push('SET FOREIGN_KEY_CHECKS = 1;');
  return out.join('\n');
}

/** Read a generated .sql file into individual statements. */
export function splitStatements(sql) {
  return sql
    .split(/\n(?=(?:CREATE TABLE|ALTER TABLE|SET |-- ))/)
    .join('\n')
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.replace(/^\s*(?:--[^\n]*\n\s*)*/, '').trim())
    .filter(Boolean);
}

export function loadRecordsFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Encode a nested value into flat (path, kind, value) rows. */
export function encodeValue(prefix, value, rows) {
  if (value === null || value === undefined) {
    rows.push({ path: prefix, kind: 'null' });
    return;
  }
  if (typeof value === 'string') {
    rows.push({ path: prefix, kind: 'string', value_text: value });
    return;
  }
  if (typeof value === 'number') {
    rows.push({ path: prefix, kind: 'number', value_number: value });
    return;
  }
  if (typeof value === 'boolean') {
    rows.push({ path: prefix, kind: 'boolean', value_bool: value ? 1 : 0 });
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      rows.push({ path: prefix, kind: 'array' });
      return;
    }
    value.forEach((item, i) => encodeValue(`${prefix}[${i}]`, item, rows));
    return;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      rows.push({ path: prefix, kind: 'object' });
      return;
    }
    for (const key of keys) encodeValue(prefix ? `${prefix}.${key}` : key, value[key], rows);
    return;
  }
  throw new Error(`Cannot encode value of type ${typeof value}`);
}

/** Parse a flat path (`payload.data.is_locked`, `tags[0]`) into tokens. */
export function parsePath(path) {
  const tokens = [];
  let current = '';
  for (let i = 0; i < path.length; i += 1) {
    const ch = path[i];
    if (ch === '.') {
      if (current) tokens.push({ type: 'key', value: current });
      current = '';
      continue;
    }
    if (ch === '[') {
      if (current) tokens.push({ type: 'key', value: current });
      current = '';
      const end = path.indexOf(']', i);
      tokens.push({ type: 'index', value: Number(path.slice(i + 1, end)) });
      i = end;
      continue;
    }
    current += ch;
  }
  if (current) tokens.push({ type: 'key', value: current });
  return tokens;
}

/** Decode flat (path, kind, value) rows back into the original value tree. */
export function decodeRows(rows) {
  const root = {};
  for (const row of rows) {
    const tokens = parsePath(row.path);
    if (tokens.length === 0) continue;
    let value;
    if (row.kind === 'null') value = null;
    else if (row.kind === 'string') value = row.value_text;
    else if (row.kind === 'number') value = Number(row.value_number);
    else if (row.kind === 'boolean') value = Boolean(row.value_bool);
    else if (row.kind === 'array') value = [];
    else if (row.kind === 'object') value = {};
    else throw new Error(`Unknown extras kind ${row.kind} at ${row.path}`);

    let node = root;
    for (let i = 0; i < tokens.length - 1; i += 1) {
      const token = tokens[i];
      const next = tokens[i + 1];
      if (node[token.value] === undefined) node[token.value] = next.type === 'index' ? [] : {};
      node = node[token.value];
    }
    node[tokens[tokens.length - 1].value] = value;
  }
  return root;
}
