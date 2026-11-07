/**
 * Report-grade ER diagrams — custom grid renderer (readable at print size).
 *
 *   DB_PASS=... [DB_NAME_REL=...] node migrations/relational/erd-report.mjs
 *
 * Reads information_schema from the live relational database and writes to
 * docs/erd/report/:
 *   erd-<domain>[-<n>].html  one page per (sub)diagram: entity boxes with all
 *                            columns (PK/FK marks), SVG FK arrows, white bg
 *   overview.html            domain map with cross-domain FK counts
 *   report-manifest.json     machine-readable list of pages for the PDF step
 *
 * Pages signal render readiness to the screenshot driver via
 * window.__READY = {w, h} (content size) after fonts settle.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mysql = createRequire(path.join(ROOT, 'dbproxy', 'package.json'))('mysql2/promise');

const DB = process.env.DB_NAME_REL ?? 'restaurant_manager_relational';
const OUT_DIR = path.join(ROOT, 'docs', 'erd', 'report');

const CONN = {
  host: process.env.DB_HOST ?? process.env.MYSQL_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3307),
  user: process.env.DB_USER ?? process.env.MYSQL_USER ?? 'restaurant',
  password: process.env.DB_PASS ?? process.env.MYSQL_PASSWORD,
  database: DB,
  timezone: '+00:00',
};

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

const DOMAIN_TITLES = {
  'order-payment': 'Đơn hàng & Thanh toán',
  'menu-recipe': 'Thực đơn & Công thức',
  inventory: 'Kho & Nguyên liệu',
  hr: 'Nhân sự & Lương',
  integration: 'Tích hợp ngoài',
  auth: 'Đăng nhập & Phân quyền',
  sync: 'Đồng bộ nhiều máy POS',
  kitchen: 'Bếp & In món',
  buffet: 'Buffet',
  discount: 'Khuyến mãi & Giảm giá',
  accounting: 'Sổ kế toán',
  floor: 'Sơ đồ bàn',
  customer: 'Khách hàng',
  core: 'Dữ liệu lõi dùng chung',
};

const DOMAIN_DESC = {
  'order-payment': 'Trung tâm nghiệp vụ: đơn hàng, dòng món, thanh toán, hoàn tiền, khoá ca. Bảng `order` được tham chiếu nhiều nhất trong toàn bộ lược đồ.',
  'menu-recipe': 'Thực đơn, món ăn, nhóm modifier, công thức nấu và giá theo menu.',
  inventory: 'Nguyên liệu, định mức, nhà cung cấp, phiếu nhập/xuất/điều chỉnh và sổ kho.',
  hr: 'Nhân viên, ca làm việc, chấm công, nghỉ phép, bảng lương.',
  integration: 'Cấu hình kết nối đối tác ngoài (provider, webhook, hàng đợi đồng bộ).',
  auth: 'Tài khoản đăng nhập, vai trò, quyền và phiên làm việc.',
  sync: 'Đồng bộ dữ liệu giữa các terminal POS và cloud (event, cursor, xung đột).',
  kitchen: 'Cấu hình bếp, máy in, luồng chế biến món.',
  buffet: 'Phiên buffet, menu theo đầu khách, định mức tiêu thụ.',
  discount: 'Mã giảm giá, coupon, chương trình khuyến mãi.',
  accounting: 'Sổ nhật ký kế toán, nhóm tài khoản.',
  floor: 'Khu vực và bàn ăn.',
  customer: 'Khách hàng thân thiết, địa chỉ, thẻ thành viên.',
  core: 'Bảng dùng chung: document, ghi chú, cài đặt hệ thống, thuế, kiểu đơn.',
};

const DOMAIN_COLORS = {
  'order-payment': '#3b5bdb', 'menu-recipe': '#e8590c', inventory: '#0b7285', hr: '#5f3dc4',
  integration: '#862e9c', auth: '#2b8a3e', sync: '#1864ab', kitchen: '#c92a2a',
  buffet: '#a61e4d', discount: '#7048e8', accounting: '#087f5b', floor: '#1971c2',
  customer: '#d9480f', core: '#495057',
};

const isAttrs = (n) => n.endsWith('__attrs');
const domainOf = (name) => {
  for (const [pattern, domain] of DOMAIN_RULES) if (pattern.test(name)) return domain;
  return 'core';
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const shortType = (t) => {
  const s = String(t).toLowerCase();
  if (s.startsWith('tinyint(1)')) return 'bool';
  return s.replace(/\(.*\)/, '').replace(/\s.*$/, '') || 'text';
};

/** Prefix group inside a domain: first two tokens when possible. */
const prefixOf = (name) => {
  const parts = name.split('_');
  return parts.slice(0, Math.min(2, parts.length)).join('_');
};

async function main() {
  const conn = await mysql.createConnection(CONN);
  const [cols] = await conn.query(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS type, COLUMN_KEY AS ckey
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`, [DB]);
  const [fks] = await conn.query(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, REFERENCED_TABLE_NAME AS rt
     FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`, [DB]);
  await conn.end();

  const columns = new Map();
  for (const r of cols) {
    if (isAttrs(r.t)) continue;
    if (!columns.has(r.t)) columns.set(r.t, []);
    columns.get(r.t).push({ name: r.c, type: r.type, pk: r.ckey === 'PRI' });
  }
  const META = new Set(['change_log', 'field_kinds', 'unique_indexes', 'field_defaults', 'event_defs', 'records', 'tracking', 'tracking_events', '_schema_migration']);
  const fkList = fks.filter((f) => columns.has(f.t) && !META.has(f.t) && columns.has(f.rt));
  const fkByTable = new Map();
  for (const f of fkList) {
    if (!fkByTable.has(f.t)) fkByTable.set(f.t, []);
    fkByTable.get(f.t).push(f);
  }

  const business = [...columns.keys()].filter((t) => !META.has(t));
  const byDomain = new Map();
  for (const t of business) {
    const d = domainOf(t);
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push(t);
  }
  const domains = [...byDomain.keys()].sort((a, b) => byDomain.get(b).length - byDomain.get(a).length);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifest = { database: DB, pages: [], domains: {} };

  /** Split a domain into diagram groups when it is too wide for one page. */
  function groupsOf(domain, tables) {
    if (tables.length <= 22) return [{ name: domain, title: DOMAIN_TITLES[domain] ?? domain, tables }];
    const byPrefix = new Map();
    for (const t of tables) {
      const p = prefixOf(t);
      if (!byPrefix.has(p)) byPrefix.set(p, []);
      byPrefix.get(p).push(t);
    }
    let groups = [...byPrefix.entries()].sort((a, b) => b[1].length - a[1].length);
    // merge groups smaller than 4 into a compatible group, keeping <= 22 each
    for (let i = groups.length - 1; i >= 0; i--) {
      if (groups[i][1].length >= 4 || groups.length === 1) continue;
      let best = -1, bestScore = -1;
      for (let j = 0; j < groups.length; j++) {
        if (j === i || groups[j][1].length + groups[i][1].length > 22) continue;
        const shared = groups[j][0].split('_')[0] === groups[i][0].split('_')[0] ? 1 : 0;
        if (shared > bestScore) { bestScore = shared; best = j; }
      }
      if (best >= 0) { groups[best][1].push(...groups[i][1]); groups.splice(i, 1); continue; }
      // nothing shares a token: merge into the biggest group that still fits
      for (let j = 0; j < groups.length; j++) {
        if (j !== i && groups[j][1].length + groups[i][1].length <= 22) { groups[j][1].push(...groups[i][1]); groups.splice(i, 1); break; }
      }
    }
    groups = groups.filter(([, ts]) => ts.length > 0).sort((a, b) => b[1].length - a[1].length);
    return groups.map(([p, ts], i) => ({
      name: `${domain}-${i + 1}`,
      title: `${DOMAIN_TITLES[domain] ?? domain} — nhóm ${p}`,
      tables: ts.sort(),
    }));
  }

  /** Grid layout: entity boxes in columns; hubs (most referenced) go left. */
  function layoutBoxes(entities, edgeList) {
    const W = 268, H_GAP = 26, PAD = 40;
    const referenced = new Map();
    for (const e of edgeList) {
      if (!entities.has(e.to)) continue;
      referenced.set(e.to, (referenced.get(e.to) ?? 0) + 1);
    }
    const order = [...entities.keys()].sort((a, b) =>
      (referenced.get(b) ?? 0) - (referenced.get(a) ?? 0) || a.localeCompare(b));
    const heights = new Map();
    for (const t of entities.keys()) {
      heights.set(t, 34 + entities.get(t).length * 21 + 10);
    }
    const n = order.length;
    const nCols = Math.max(3, Math.min(9, Math.ceil(Math.sqrt(n * 1.35))));
    const perCol = Math.ceil(n / nCols);
    const pos = new Map();
    let x = PAD, maxColBottom = 0;
    for (let c = 0; c < nCols; c++) {
      const colTables = order.slice(c * perCol, (c + 1) * perCol);
      let y = PAD;
      for (const t of colTables) {
        pos.set(t, { x, y, w: W, h: heights.get(t) });
        y += heights.get(t) + H_GAP;
      }
      maxColBottom = Math.max(maxColBottom, y);
      x += W + 64;
    }
    return { pos, width: x, height: maxColBottom + PAD };
  }

  function diagramPage(group, domain) {
    const color = DOMAIN_COLORS[domain] ?? '#495057';
    const inSet = new Set(group.tables);
    const set = new Map();
    for (const t of group.tables) set.set(t, columns.get(t));

    // FK edges among the set; stubs for outside references.
    const edges = [];
    const stubs = new Map();
    for (const t of group.tables) {
      for (const f of fkByTable.get(t) ?? []) {
        if (inSet.has(f.rt)) edges.push({ from: t, to: f.rt, col: f.c });
        else if (columns.has(f.rt)) {
          if (!stubs.has(f.rt)) stubs.set(f.rt, new Set());
          stubs.get(f.rt).add(t);
          edges.push({ from: t, to: f.rt, col: f.c, stub: true });
        }
      }
    }
    const merged = new Map();
    for (const e of edges) {
      const k = `${e.from}=>${e.to}`;
      if (!merged.has(k)) merged.set(k, { from: e.from, to: e.to, cols: [], stub: e.stub });
      merged.get(k).cols.push(e.col);
    }
    const edgeList = [...merged.values()];

    for (const s of stubs.keys()) {
      if (!set.has(s)) set.set(s, [{ name: 'id', type: 'varchar', pk: true }]);
    }

    const { pos, width, height } = layoutBoxes(set, edgeList);

    const edgeParts = [];
    for (const e of edgeList) {
      const a = pos.get(e.from), b = pos.get(e.to);
      if (!a || !b) continue;
      const label = e.cols.length <= 2 ? e.cols.join(', ') : `${e.cols.length} FK`;
      const dash = e.stub ? ' stroke-dasharray="5 4"' : '';
      let d, lp = null;
      if (b.x > a.x + a.w) {
        const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2;
        const dx = Math.max(40, Math.abs(x2 - x1) / 2);
        d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
        lp = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
      } else if (b.x + b.w < a.x) {
        const x1 = a.x, y1 = a.y + a.h / 2, x2 = b.x + b.w, y2 = b.y + b.h / 2;
        const dx = Math.max(40, Math.abs(x2 - x1) / 2);
        d = `M ${x1} ${y1} C ${x1 - dx} ${y1}, ${x2 + dx} ${y2}, ${x2} ${y2}`;
        lp = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
      } else {
        const midX = Math.max(a.x, b.x) + 134;
        if (a.y > b.y) d = `M ${midX} ${a.y} L ${midX} ${b.y + b.h}`;
        else d = `M ${midX} ${a.y + a.h} L ${midX} ${b.y}`;
        lp = null; // vertical edges: no label to avoid overlap
      }
      edgeParts.push(`<path d="${d}" fill="none" stroke="#8494ab" stroke-width="1.4" opacity="0.75"${dash} marker-end="url(#arrow)"/>` +
        (label && lp ? `<text x="${lp.x}" y="${lp.y - 5}" font-size="11" fill="#4a5a72" text-anchor="middle" stroke="#ffffff" stroke-width="3" paint-order="stroke" font-style="italic">${esc(label)}</text>` : ''));
    }

    const boxes = [];
    for (const [t, p] of pos) {
      const isStub = !inSet.has(t);
      const head = isStub ? '#94a3b8' : color;
      const colDefs = set.get(t);
      const rows = colDefs.map((c) => {
        const fk = !isStub && fkList.some((f) => f.t === t && f.c === c.name);
        const badges = (c.pk ? '<span class="b pk">PK</span>' : '') + (fk ? '<span class="b fk">FK</span>' : '');
        return `<div class="r"><span class="cn">${esc(c.name)}</span><span class="ct">${c.pk ? '<u>' + esc(shortType(c.type)) + '</u>' : esc(shortType(c.type))}</span>${badges}</div>`;
      }).join('');
      const border = isStub ? 'border:1.6px dashed #94a3b8;' : `border:1.6px solid ${color};`;
      const note = isStub ? `<div class="stub">ngoài nhóm này</div>` : '';
      boxes.push(`<div class="ent" style="left:${p.x}px;top:${p.y}px;width:${p.w}px;${border}">
        <div class="eh" style="background:${head}">${esc(t)}</div>${note}${rows}</div>`);
    }

    const html = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><title>${esc(group.title)}</title>
<style>
  body { background:#fff; color:#111827; font-family:'Segoe UI',system-ui,sans-serif; margin:0; padding:28px 36px; }
  h1 { font-size:25px; margin:0 0 4px; }
  h1 .chip { display:inline-block; width:16px; height:16px; border-radius:4px; background:${color}; vertical-align:-2px; margin-right:10px; }
  .sub { color:#4b5563; font-size:14px; margin-bottom:14px; }
  .legend { font-size:12.5px; color:#4b5563; margin-bottom:12px; }
  .b { font-size:9.5px; font-weight:700; border-radius:3px; padding:0 4px; margin-left:4px; vertical-align:1px; }
  .pk { background:#1d4ed8; color:#fff; }
  .fk { background:#c2410c; color:#fff; }
  .wrap { position:relative; }
  .ent { position:absolute; background:#fff; border-radius:6px; box-shadow:0 1px 4px rgba(15,23,42,.14); overflow:hidden; }
  .eh { color:#fff; font-weight:700; font-size:13.5px; padding:5px 9px; letter-spacing:.2px; }
  .stub { font-size:10px; color:#64748b; padding:2px 9px; background:#f1f5f9; }
  .r { display:flex; align-items:center; font-size:12px; padding:2.5px 9px; }
  .r:nth-child(even) { background:#f7f9fc; }
  .cn { flex:1; font-family:Consolas,ui-monospace,monospace; font-size:11.5px; white-space:nowrap; }
  .ct { color:#6b7280; font-size:10.5px; margin-left:8px; white-space:nowrap; }
</style></head>
<body>
  <h1><span class="chip"></span>${esc(group.title)}
      <span style="font-size:14px;color:#6b7280;font-weight:normal"> — ${inSet.size} bảng${stubs.size ? ` + ${stubs.size} bảng tham chiếu` : ''} · domain <code>${esc(domain)}</code></span></h1>
  <div class="sub">${esc(DOMAIN_DESC[domain] ?? '')}</div>
  <div class="legend"><b>PK</b> khóa chính (kiểu gạch chân) · <b>FK</b> khóa ngoại · nhãn nghiêng trên đường nối = cột FK · đường đứt nét = tham chiếu sang nhóm khác · mũi tên chỉ về bảng được tham chiếu</div>
  <div class="wrap" id="wrap" style="width:${width}px;height:${height}px">
    <svg id="edges" width="${width}" height="${height}" style="position:absolute;left:0;top:0">
      <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8494ab"/></marker></defs>
      ${edgeParts.join('\n      ')}
    </svg>
    ${boxes.join('\n    ')}
  </div>
  <script>
    window.addEventListener('load', () => {
      const w = document.getElementById('wrap');
      window.__READY = { w: Math.ceil(w.offsetWidth) + 72, h: Math.ceil(w.offsetHeight) + 120 };
      document.title = 'OK ' + document.title;
    });
  </script>
</body></html>`;
    fs.writeFileSync(path.join(OUT_DIR, `${group.name}.html`), html);
    manifest.pages.push({ page: group.name, domain, title: group.title, tables: inSet.size, stubs: stubs.size, size: [Math.ceil(width), Math.ceil(height)] });
  }

  for (const domain of domains) {
    for (const g of groupsOf(domain, byDomain.get(domain))) diagramPage(g, domain);
    manifest.domains[domain] = { title: DOMAIN_TITLES[domain] ?? domain, tables: byDomain.get(domain).length, color: DOMAIN_COLORS[domain] ?? '#495057' };
  }

  // Overview page — circular domain map with cross-domain FK flows.
  const crossFlow = new Map();
  for (const t of business) {
    for (const f of fkByTable.get(t) ?? []) {
      const d1 = domainOf(t), d2 = domainOf(f.rt);
      if (d1 === d2) continue;
      crossFlow.set(`${d1}=>${d2}`, (crossFlow.get(`${d1}=>${d2}`) ?? 0) + 1);
    }
  }
  const flows = [...crossFlow.entries()].map(([k, v]) => { const [a, b] = k.split('=>'); return { a, b, v }; }).sort((x, y) => y.v - x.v);
  manifest.flows = flows.map((f) => ({ from: f.a, to: f.b, count: f.v }));

  const cx = 670, cy = 530, RX = 560, RY = 330;
  const dpos = new Map();
  domains.forEach((d, i) => {
    const ang = (2 * Math.PI * i) / domains.length - Math.PI / 2;
    dpos.set(d, { x: cx + RX * Math.cos(ang), y: cy + RY * Math.sin(ang) });
  });
  const ovEdges = [];
  for (const f of flows) {
    const a = dpos.get(f.a), b = dpos.get(f.b);
    if (!a || !b) continue;
    const mx = (a.x + b.x) / 2 + (b.y - a.y) * 0.14, my = (a.y + b.y) / 2 - (b.x - a.x) * 0.14;
    ovEdges.push(`<path d="M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}" fill="none" stroke="#8494ab" stroke-width="${Math.min(5, 1.2 + f.v / 10)}" opacity="${Math.min(0.85, 0.3 + f.v / 25)}" marker-end="url(#arrow2)"/>
      <text x="${mx}" y="${my}" font-size="16" fill="#334155" text-anchor="middle" stroke="#fff" stroke-width="4" paint-order="stroke" font-weight="600">${f.v} FK</text>`);
  }
  const ovNodes = domains.map((d) => {
    const p = dpos.get(d), c = DOMAIN_COLORS[d] ?? '#495057';
    return `<g><rect x="${p.x - 108}" y="${p.y - 32}" width="216" height="64" rx="10" fill="#fff" stroke="${c}" stroke-width="3"/>
      <text x="${p.x}" y="${p.y - 2}" text-anchor="middle" font-size="19" font-weight="700" fill="#111827">${esc(DOMAIN_TITLES[d] ?? d)}</text>
      <text x="${p.x}" y="${p.y + 21}" text-anchor="middle" font-size="14.5" fill="#6b7280">${byDomain.get(d).length} bảng</text></g>`;
  }).join('\n');
  const ovHtml = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><title>Tổng quan ${domains.length} phân hệ</title>
<style>body{background:#fff;font-family:'Segoe UI',system-ui,sans-serif;margin:0;padding:28px 36px}h1{font-size:25px;margin:0 0 4px}.sub{color:#4b5563;font-size:14px;margin-bottom:10px}</style></head>
<body><h1>Sơ đồ tổng quan — ${domains.length} phân hệ & luồng khóa ngoại liên phân hệ</h1>
<div class="sub">Số trên cung = số khóa ngoại đi sang phân hệ khác. Độ đậm cung tỉ lệ với số FK. Chi tiết từng phân hệ ở các trang sau.</div>
<svg width="1340" height="1060" style="max-width:100%">
  <defs><marker id="arrow2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8494ab"/></marker></defs>
  ${ovEdges.join('\n')}
  ${ovNodes}
</svg>
<script>window.addEventListener('load',()=>{window.__READY={w:1420,h:1140};document.title='OK '+document.title;});</script>
</body></html>`;
  fs.writeFileSync(path.join(OUT_DIR, 'overview.html'), ovHtml);
  manifest.pages.unshift({ page: 'overview', domain: 'overview', title: 'Sơ đồ tổng quan', tables: business.length, stubs: 0, size: [1280, 1080] });

  fs.writeFileSync(path.join(OUT_DIR, 'report-manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`pages: ${manifest.pages.length}; business tables: ${business.length}`);
  for (const p of manifest.pages) console.log(`  ${p.page}: ${p.tables} bảng (${p.size[0]}x${p.size[1]})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
