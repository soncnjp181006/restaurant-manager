/**
 * Draw the ER diagram that actually lives in MySQL.
 *
 *   DB_PASS=... DB_NAME_REL=restaurant_manager_relational node migrations/relational/erd.mjs
 *
 * Reads information_schema (tables, columns, foreign keys) from the live
 * relational database and writes:
 *
 *   docs/erd/relational-live.mmd    Mermaid ER, one edge per real FK
 *   docs/erd/relational-live.dbml   DBML (paste into dbdiagram.io / dbdocs)
 *   docs/erd/relational-live.html   standalone page that renders the Mermaid
 *                                   graph in a browser, so the links are visible
 *                                   even when a client hides collapsed tables
 *
 * Flags
 *   --all        include every table, including the `*__attrs` value tables
 *                and dbproxy metadata tables (default: business tables only)
 *   --database   override DB_NAME_REL
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mysql = createRequire(path.join(ROOT, 'dbproxy', 'package.json'))('mysql2/promise');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const dbArgIndex = argv.indexOf('--database');

const DB = dbArgIndex >= 0 ? argv[dbArgIndex + 1] : process.env.DB_NAME_REL ?? 'restaurant_manager_relational';
const OUT_DIR = path.join(ROOT, 'docs', 'erd');

const CONN = {
  host: process.env.DB_HOST ?? process.env.MYSQL_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3307),
  user: process.env.DB_USER ?? process.env.MYSQL_USER ?? 'restaurant',
  password: process.env.DB_PASS ?? process.env.MYSQL_PASSWORD,
  database: DB,
  timezone: '+00:00',
};

/** Internal plumbing that is not worth a box in the picture. */
const NOISE = new Set([
  'change_log',
  'field_kinds',
  'unique_indexes',
  'field_defaults',
  'event_defs',
  'records',
  'tracking_events',
  'tracking',
]);

function isAttrsTable(name) {
  return name.endsWith('__attrs');
}

/** Colour grouping for the full diagram: first matching rule wins. */
const DOMAIN_RULES = [
  [/^sync_/, 'sync'],
  [/^integration/, 'integration'],
  [/^buffet/, 'buffet'],
  [/^(inventory|stock|purchase|supplier|production_batch|transfer|uom|adjustment|waste)/, 'inventory'],
  [/^(order|payment|day_closing|closing|void|refund)/, 'order-payment'],
  [/^(menu|recipe|modifier|category|product|price|tax|combo|catalog)/, 'menu-recipe'],
  [/^(kitchen|printer|station)/, 'kitchen'],
  [/^(employee|payroll|attendance|leave|schedule|work_schedule|workflow|position|department|labor|timesheet|shift|clock|overtime)/, 'hr'],
  [/^(user|role|permission|session|token|auth|account_group|two_factor)/, 'auth'],
  [/^(account|journal|ledger|fiscal|expense|gl_|vat)/, 'accounting'],
  [/^(discount|promo|coupon|voucher|loyalty|reward)/, 'discount'],
  [/^(floor|table|area|room)/, 'floor'],
  [/^(customer|guest)/, 'customer'],
];

const DOMAIN_COLORS = {
  sync: { color: '#6ea8fe' },
  integration: { color: '#b197fc' },
  buffet: { color: '#f783ac' },
  inventory: { color: '#63e6be' },
  'order-payment': { color: '#ffd479' },
  'menu-recipe': { color: '#ffa94d' },
  kitchen: { color: '#ff8787' },
  hr: { color: '#74c0fc' },
  auth: { color: '#a9e34b' },
  accounting: { color: '#38d9a9' },
  discount: { color: '#e599f7' },
  floor: { color: '#4dabf7' },
  customer: { color: '#ffc9c9' },
  core: { color: '#adb5bd' },
  attrs: { color: '#495057' },
  metadata: { color: '#868e96' },
};

function domainOf(name) {
  if (isAttrsTable(name)) return 'attrs';
  if (NOISE.has(name) || name === '_schema_migration') return 'metadata';
  for (const [pattern, domain] of DOMAIN_RULES) {
    if (pattern.test(name)) return domain;
  }
  return 'core';
}

function mermaidType(columnType) {
  return String(columnType)
    .toLowerCase()
    .replace(/\(.*\)/, '')
    .replace(/\s+unsigned.*$/, '')
    .replace(/\s+.*$/, '')
    .replace(/[^a-z0-9_]/g, '_') || 'string';
}

function mermaidName(name) {
  // Mermaid entity ids cannot contain the characters MySQL allows.
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}

function dbmlType(columnType) {
  return String(columnType).replace(/\s+unsigned/i, '');
}

async function main() {
  const conn = await mysql.createConnection(CONN);
  try {
    const [columns] = await conn.query(
      `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS type,
              IS_NULLABLE AS nullable, COLUMN_KEY AS ckey
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [DB]
    );
    const [fks] = await conn.query(
      `SELECT TABLE_NAME AS t, COLUMN_NAME AS c,
              REFERENCED_TABLE_NAME AS rt, REFERENCED_COLUMN_NAME AS rc,
              CONSTRAINT_NAME AS name, ORDINAL_POSITION AS pos
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
      [DB]
    );

    const all = flag('all');
    const keep = (name) => all || (!isAttrsTable(name) && !NOISE.has(name));

    const tables = new Map();
    for (const row of columns) {
      if (!keep(row.t)) continue;
      if (!tables.has(row.t)) tables.set(row.t, []);
      tables.get(row.t).push(row);
    }

    const links = fks.filter((fk) => tables.has(fk.t) && tables.has(fk.rt));

    // Everything, for the full-schema diagram.
    const tablesAll = new Map();
    for (const row of columns) {
      if (!tablesAll.has(row.t)) tablesAll.set(row.t, []);
      tablesAll.get(row.t).push(row);
    }
    const fksAll = fks.filter((fk) => tablesAll.has(fk.t) && tablesAll.has(fk.rt));

    // ---- Mermaid ---------------------------------------------------------
    const seen = new Set();
    const lines = [
      '%% Generated by migrations/relational/erd.mjs from information_schema — real FOREIGN KEYs.',
      `%% ${DB}: ${tables.size} tables, ${links.length} foreign keys.`,
      'erDiagram',
    ];
    for (const fk of links) {
      const key = `${fk.t}.${fk.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`  ${mermaidName(fk.t)} }o--|| ${mermaidName(fk.rt)} : "${fk.c}"`);
    }
    for (const [name, cols] of tables) {
      lines.push(`  ${mermaidName(name)} {`);
      for (const col of cols) {
        const pk = col.ckey === 'PRI' ? ' PK' : '';
        lines.push(`    ${mermaidType(col.type)} ${col.c.replace(/[^A-Za-z0-9_]/g, '_')}${pk}`);
      }
      lines.push('  }');
    }
    const mermaid = `${lines.join('\n')}\n`;

    // ---- DBML ------------------------------------------------------------
    const refByTable = new Map();
    for (const fk of links) {
      if (!refByTable.has(fk.t)) refByTable.set(fk.t, new Map());
      refByTable.get(fk.t).set(fk.c, fk);
    }
    const dbml = [];
    for (const [name, cols] of tables) {
      dbml.push(`Table ${name} {`);
      for (const col of cols) {
        const attrs = [];
        if (col.ckey === 'PRI') attrs.push('pk');
        if (col.nullable === 'NO' && col.ckey !== 'PRI') attrs.push('not null');
        const fk = refByTable.get(name)?.get(col.c);
        if (fk) attrs.push(`ref: > ${fk.rt}.${fk.rc}`);
        dbml.push(`  ${col.c} ${dbmlType(col.type)}${attrs.length ? ` [${attrs.join(', ')}]` : ''}`);
      }
      dbml.push('}');
      dbml.push('');
    }
    const dbmlText = dbml.join('\n');

    // ---- HTML ------------------------------------------------------------
    // The whole schema is too big to render at once, so the page embeds the
    // graph and draws the neighbourhood of whichever table you pick.
    const schema = {
      db: DB,
      tables: [...tables.entries()].map(([name, cols]) => ({
        name,
        columns: cols.map((c) => ({
          name: c.c,
          type: mermaidType(c.type),
          pk: c.ckey === 'PRI',
        })),
      })),
      links: links.map((fk) => ({ from: fk.t, to: fk.rt, column: fk.c })),
    };
    const html = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<title>ERD · ${DB}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #16171d; color: #e6e6e6; font: 14px/1.5 system-ui, sans-serif; }
  header { padding: 14px 20px; border-bottom: 1px solid #2a2c36; position: sticky; top: 0; background: #16171d; z-index: 2; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  h1 { font-size: 15px; margin: 0; }
  .meta { color: #9aa0b0; font-size: 12px; }
  select, input { background: #23252f; color: #e6e6e6; border: 1px solid #343744; border-radius: 6px; padding: 6px 8px; font: inherit; }
  #diagram { padding: 20px; overflow: auto; }
  #diagram svg { max-width: none; }
  .hint { color: #9aa0b0; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>${DB}</h1>
  <div class="meta">${tables.size} bảng · ${links.length} khóa ngoại (sinh từ information_schema)</div>
  <label class="meta">Bảng: <select id="pick"></select></label>
  <label class="meta">Bán kính: <select id="hops"><option value="1" selected>1 bước</option><option value="2">2 bước</option><option value="3">3 bước</option></select></label>
  <span class="hint" id="count"></span>
</header>
<div id="diagram"></div>
<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
  mermaid.initialize({ startOnLoad: false, theme: 'dark', maxTextSize: 5000000, maxEdges: 5000, er: { minEntityWidth: 120 } });

  const SCHEMA = ${JSON.stringify(schema)};
  const byName = new Map(SCHEMA.tables.map((t) => [t.name, t]));
  const pick = document.getElementById('pick');
  const hops = document.getElementById('hops');
  const count = document.getElementById('count');
  const target = document.getElementById('diagram');

  pick.innerHTML = SCHEMA.tables.map((t) => \`<option value="\${t.name}">\${t.name}</option>\`).join('');
  const preselect = new URLSearchParams(location.search).get('table') || 'order';
  if (byName.has(preselect)) pick.value = preselect;

  function neighbourhood(root, depth) {
    const keep = new Set([root]);
    let frontier = [root];
    for (let d = 0; d < depth; d += 1) {
      const next = [];
      for (const name of frontier) {
        for (const link of SCHEMA.links) {
          if (link.from !== name && link.to !== name) continue;
          const other = link.from === name ? link.to : link.from;
          if (!keep.has(other)) { keep.add(other); next.push(other); }
        }
      }
      frontier = next;
    }
    return keep;
  }

  function source(root, depth) {
    const keep = neighbourhood(root, depth);
    const links = SCHEMA.links.filter((l) => keep.has(l.from) && keep.has(l.to));
    const lines = ['erDiagram'];
    for (const link of links) lines.push(\`  \${link.from} }o--|| \${link.to} : "\${link.column}"\`);
    for (const name of keep) {
      const table = byName.get(name);
      lines.push(\`  \${name} {\`);
      for (const col of table.columns) lines.push(\`    \${col.type} \${col.name}\${col.pk ? ' PK' : ''}\`);
      lines.push('  }');
    }
    return { text: lines.join('\\n'), tables: keep.size, links: links.length };
  }

  let seq = 0;
  async function render() {
    const { text, tables, links } = source(pick.value, Number(hops.value));
    count.textContent = \`\${tables} bảng · \${links} liên kết\`;
    seq += 1;
    try {
      const { svg } = await mermaid.render(\`erd\${seq}\`, text);
      target.innerHTML = svg;
      history.replaceState(null, '', \`?table=\${encodeURIComponent(pick.value)}\`);
    } catch (error) {
      target.textContent = 'Render error: ' + error.message;
    }
  }

  pick.addEventListener('change', render);
  hops.addEventListener('change', render);
  render();
</script>
</body>
</html>
`;

    // ---- Full-schema interactive diagram --------------------------------
    // Every table and every FK of the database, drawn by vis-network so the
    // whole model stays readable (zoom / drag / search / focus).
    const full = {
      db: DB,
      tables: [...tablesAll.entries()].map(([name, cols]) => ({
        name,
        domain: domainOf(name),
        columns: cols.map((c) => ({
          name: c.c,
          type: dbmlType(c.type),
          pk: c.ckey === 'PRI',
        })),
      })),
      links: fksAll.map((fk) => ({ from: fk.t, to: fk.rt, column: fk.c, attrs: isAttrsTable(fk.t) })),
    };
    const fullHtml = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<title>ERD đầy đủ · ${DB}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #14151b; color: #e6e6e6; font: 13px/1.5 system-ui, sans-serif; overflow: hidden; }
  header { position: absolute; inset: 0 0 auto 0; z-index: 5; display: flex; gap: 14px; align-items: center; flex-wrap: wrap;
           padding: 10px 16px; background: rgba(20,21,27,.94); border-bottom: 1px solid #2a2c36; }
  h1 { font-size: 14px; margin: 0; }
  .meta { color: #9aa0b0; font-size: 12px; }
  input, select, button { background: #23252f; color: #e6e6e6; border: 1px solid #343744; border-radius: 6px;
           padding: 5px 8px; font: inherit; }
  button { cursor: pointer; }
  button:hover { background: #2c2f3b; }
  #graph { position: absolute; inset: 44px 0 0 0; }
  #legend { position: absolute; left: 14px; bottom: 14px; z-index: 5; display: flex; gap: 10px; flex-wrap: wrap;
            max-width: 70vw; background: rgba(20,21,27,.9); border: 1px solid #2a2c36; border-radius: 8px; padding: 8px 10px; }
  .lg { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #c3c8d4; }
  .dot { width: 10px; height: 10px; border-radius: 50%; }
  #info { position: absolute; right: 14px; bottom: 14px; z-index: 5; width: 330px; max-height: 62vh; overflow: auto;
          background: rgba(20,21,27,.95); border: 1px solid #2a2c36; border-radius: 8px; padding: 10px 12px; display: none; }
  #info h2 { font-size: 13px; margin: 0 0 6px; font-family: ui-monospace, monospace; }
  #info table { width: 100%; border-collapse: collapse; font-size: 11px; }
  #info td { padding: 2px 4px; border-bottom: 1px solid #24262f; }
  #info td:first-child { color: #9aa0b0; font-family: ui-monospace, monospace; }
  #info .pk { color: #ffd479; }
</style>
</head>
<body>
<header>
  <h1>ERD đầy đủ · ${DB}</h1>
  <div class="meta" id="counts"></div>
  <input id="search" placeholder="Tìm bảng…" size="18" />
  <label class="meta"><input type="checkbox" id="hideAttrs" checked /> ẩn bảng __attrs &amp; metadata</label>
  <label class="meta"><input type="checkbox" id="showCols" checked /> hiện số cột</label>
  <label class="meta"><input type="checkbox" id="physics" /> dàn lực</label>
  <button id="fit">Fit</button>
  <button id="clear">Bỏ chọn</button>
</header>
<div id="graph"></div>
<div id="legend"></div>
<div id="info"></div>
<script src="https://cdn.jsdelivr.net/npm/vis-network@9.1.9/standalone/umd/vis-network.min.js"></script>
<script>
  const SCHEMA = ${JSON.stringify(full)};
  const DOMAINS = ${JSON.stringify(DOMAIN_COLORS)};
  const nodes = new vis.DataSet();
  const edges = new vis.DataSet();
  const showCols = document.getElementById('showCols');
  const hideAttrs = document.getElementById('hideAttrs');
  const counts = document.getElementById('counts');
  const info = document.getElementById('info');

  function columnsHtml(table) {
    const rows = table.columns.map((c) => \`<tr><td>\${c.name}</td><td>\${c.type}\${c.pk ? ' <span class="pk">PK</span>' : ''}</td></tr>\`).join('');
    return \`<h2>\${table.name}</h2><div class="meta">\${table.columns.length} cột · \${table.domain}</div><table>\${rows}</table>\`;
  }

  function build() {
    nodes.clear(); edges.clear();
    const hide = hideAttrs.checked;
    const visible = SCHEMA.tables.filter((t) => !hide || (t.domain !== 'attrs' && t.domain !== 'metadata'));
    const keep = new Set(visible.map((t) => t.name));
    for (const t of visible) {
      const color = DOMAINS[t.domain] ? DOMAINS[t.domain].color : '#7d8598';
      const labelText = showCols.checked ? \`\${t.name}\\n\${t.columns.length} cột\` : t.name;
      nodes.add({
        id: t.name,
        labelText,
        label: labelText,
        title: columnsHtml(t),
        group: t.domain,
        shape: t.domain === 'attrs' ? 'box' : 'box',
        font: { color: '#e6e6e6', face: 'ui-monospace, monospace', size: showCols.checked ? 12 : 13, multi: false },
        color: { background: '#1d1f27', border: color, highlight: { background: '#2a2d38', border: color } },
        borderWidth: 1.5,
        margin: 8,
      });
    }
    for (const l of SCHEMA.links) {
      if (!keep.has(l.from) || !keep.has(l.to)) continue;
      edges.add({
        id: \`\${l.from}->\${l.to}.\${l.column}\`,
        from: l.from,
        to: l.to,
        label: l.column,
        arrows: { to: { enabled: true, scaleFactor: 0.5 } },
        color: { color: l.attrs ? '#39404f' : '#4a5163', highlight: '#ffd479', opacity: 0.85 },
        font: { size: 9, color: '#8c93a5', strokeWidth: 0, align: 'middle' },
        smooth: { type: 'dynamic', roundness: 0.4 },
        isAttrs: l.attrs,
      });
    }
    counts.textContent = \`\${visible.length} bảng · \${edges.length} khóa ngoại\`;
  }

  build();

  const network = new vis.Network(
    document.getElementById('graph'),
    { nodes, edges },
    {
      layout: { improvedLayout: false, randomSeed: 7 },
      physics: { enabled: false, barnesHut: { gravitationalConstant: -9000, springLength: 130, springConstant: 0.03, damping: 0.4 } },
      interaction: { hover: true, tooltipDelay: 120, navigationButtons: true, keyboard: false, multiselect: false, hideEdgesOnDrag: true },
      edges: { width: 1 },
    }
  );

  function layoutGrid() {
    // Deterministic first view: one column per domain, so the whole schema is
    // visible at fit-zoom while still grouping related tables together.
    const byDomain = new Map();
    for (const node of nodes.get()) {
      if (!byDomain.has(node.group)) byDomain.set(node.group, []);
      byDomain.get(node.group).push(node.id);
    }
    // Each domain becomes a block of narrow columns so the whole map stays
    // roughly square instead of one 15.000px-tall strip.
    const ROWS = 16;
    const COL_W = 215;
    const ROW_H = 62;
    let x = 0;
    for (const [domain, names] of byDomain) {
      names.sort();
      const cols = Math.ceil(names.length / ROWS);
      names.forEach((id, index) => {
        const col = Math.floor(index / ROWS);
        const row = index % ROWS;
        nodes.update({ id, x: x + col * COL_W, y: row * ROW_H });
      });
      // Domain title above the block: the only thing readable at map zoom.
      const color = DOMAINS[domain] ? DOMAINS[domain].color : '#7d8598';
      nodes.add({
        id: \`__domain__\${domain}\`,
        label: domain,
        shape: 'text',
        x: x + ((cols - 1) * COL_W) / 2,
        y: -130,
        font: { size: 64, color, face: 'ui-monospace, monospace', bold: true },
        isTitle: true,
        fixed: true,
      });
      x += cols * COL_W + 160;
    }
  }

  layoutGrid();
  network.once('afterDrawing', () => network.fit({ animation: false }));

  // Below this zoom the labels would be smaller than a pixel: hide them so the
  // whole schema reads as a map, and bring them back when the user zooms in.
  const LABEL_MIN_SCALE = 0.42;
  let labelsVisible = true;
  function syncLabelVisibility() {
    const visible = network.getScale() >= LABEL_MIN_SCALE;
    if (visible === labelsVisible) return;
    labelsVisible = visible;
    nodes.update(nodes.get().filter((n) => !n.isTitle).map((n) => ({ id: n.id, label: visible ? n.labelText : '' })));
  }
  network.on('zoom', syncLabelVisibility);
  setTimeout(syncLabelVisibility, 400);

  const legend = document.getElementById('legend');
  legend.innerHTML = Object.entries(DOMAINS)
    .map(([name, d]) => \`<span class="lg"><span class="dot" style="background:\${d.color}"></span>\${name}</span>\`)
    .join('');

  network.on('click', (params) => {
    if (!params.nodes.length) { info.style.display = 'none'; return; }
    const table = SCHEMA.tables.find((t) => t.name === params.nodes[0]);
    if (!table) return;
    info.innerHTML = columnsHtml(table);
    info.style.display = 'block';
    const related = new Set([table.name]);
    for (const l of SCHEMA.links) {
      if (l.from === table.name) related.add(l.to);
      if (l.to === table.name) related.add(l.from);
    }
    nodes.update(nodes.get().filter((n) => !n.isTitle).map((n) => ({ id: n.id, opacity: related.has(n.id) ? 1 : 0.18 })));
    edges.update(edges.get().map((e) => ({
      id: e.id,
      color: { color: e.from === table.name || e.to === table.name ? '#ffd479' : '#2a2e3a', opacity: e.from === table.name || e.to === table.name ? 1 : 0.12 },
      width: e.from === table.name || e.to === table.name ? 1.6 : 1,
    })));
  });

  document.getElementById('clear').addEventListener('click', () => {
    info.style.display = 'none';
    nodes.update(nodes.get().filter((n) => !n.isTitle).map((n) => ({ id: n.id, opacity: 1 })));
    edges.update(edges.get().map((e) => ({
      id: e.id,
      color: { color: e.isAttrs ? '#39404f' : '#4a5163', opacity: 0.85 },
      width: 1,
    })));
  });

  document.getElementById('search').addEventListener('input', (event) => {
    const term = event.target.value.trim().toLowerCase();
    if (!term) { nodes.update(nodes.get().filter((n) => !n.isTitle).map((n) => ({ id: n.id, opacity: 1 }))); return; }
    const matches = new Set(nodes.get().filter((n) => !n.isTitle && n.id.toLowerCase().includes(term)).map((n) => n.id));
    nodes.update(nodes.get().filter((n) => !n.isTitle).map((n) => ({ id: n.id, opacity: matches.has(n.id) ? 1 : 0.15 })));
    if (matches.size) network.fit({ nodes: [...matches], animation: { duration: 400 } });
  });

  document.getElementById('fit').addEventListener('click', () => network.fit({ animation: false }));
  showCols.addEventListener('change', () => { build(); layoutGrid(); network.fit({ animation: false }); });
  hideAttrs.addEventListener('change', () => { build(); layoutGrid(); network.fit({ animation: false }); });
  document.getElementById('physics').addEventListener('change', (event) => {
    network.setOptions({ physics: { enabled: event.target.checked } });
  });
</script>
</body>
</html>
`;

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'relational-live.mmd'), mermaid);
    fs.writeFileSync(path.join(OUT_DIR, 'relational-live.dbml'), dbmlText);
    fs.writeFileSync(path.join(OUT_DIR, 'relational-live.html'), html);
    fs.writeFileSync(path.join(OUT_DIR, 'relational-full.html'), fullHtml);

    console.log(`${DB}: ${tables.size} business tables / ${tablesAll.size} tables total, ${links.length} business FK edges / ${fksAll.length} FK edges`);
    console.log('wrote docs/erd/relational-live.mmd, .dbml, .html');
    console.log('wrote docs/erd/relational-full.html');
  } finally {
    await conn.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
