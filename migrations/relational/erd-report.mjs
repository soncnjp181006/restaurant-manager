/**
 * Report-grade ER diagrams — sparse 2-column grid, orthogonal (right-angle) edges.
 *
 *   DB_PASS=... [DB_NAME_REL=...] node migrations/relational/erd-report.mjs
 *
 * Reads information_schema from the live relational database and writes to
 * docs/erd/report/:
 *   erd-<domain>-<k>.html    one page per diagram chunk: ~4-6 entity boxes in
 *                            2 columns, full columns, PK/FK marks, squared FK
 *                            edges routed through the central channel
 *   overview.html            domain map with cross-domain FK counts
 *   report-manifest.json     page list for the PDF builder
 *
 * Page size is deliberately small (canvas ~930px wide) so text stays large
 * when the figure is scaled into an A4 report page.
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
  'order-payment': 'Trung tâm nghiệp vụ: đơn hàng, dòng món, thanh toán, hoàn tiền, khoá ca.',
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

// ── Layout constants (CSS px). Small canvas → large text inside the report. ──
const BOX_W = 320;      // entity box width
const COL_GAP = 180;    // central channel between the 2 columns (edge routing)
const ROW_GAP = 80;     // vertical gap between boxes in a column
const PAD = 60;         // canvas padding
const COL_BUDGET = 820; // max stacked box height per column (leaves room for stubs)
const MAX_PER_COL = 3;
const ROW_H = 23, HEAD_H = 30, BOX_PAD_V = 9;

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
const boxHeight = (defs) => HEAD_H + defs.length * ROW_H + BOX_PAD_V;

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

  // global reference counts (hubs first)
  const referenced = new Map();
  for (const f of fkList) referenced.set(f.rt, (referenced.get(f.rt) ?? 0) + 1);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifest = { database: DB, pages: [], domains: {} };

  /** Pack a domain's tables into pages of 2 columns under the height budget. */
  function packPages(tables) {
    const order = tables.slice().sort((a, b) =>
      (referenced.get(b) ?? 0) - (referenced.get(a) ?? 0) || a.localeCompare(b));
    const pages = [];
    let colA = [], colB = [], hA = 0, hB = 0;
    const flush = () => { if (colA.length || colB.length) { pages.push([colA, colB]); colA = []; colB = []; hA = 0; hB = 0; } };
    for (const t of order) {
      const h = boxHeight(columns.get(t));
      if ((colA.length >= MAX_PER_COL || hA + h + ROW_GAP > COL_BUDGET) && (colB.length >= MAX_PER_COL || hB + h + ROW_GAP > COL_BUDGET)) flush();
      if (colA.length < MAX_PER_COL && hA + h + ROW_GAP <= COL_BUDGET) { colA.push(t); hA += h + ROW_GAP; }
      else if (colB.length < MAX_PER_COL && hB + h + ROW_GAP <= COL_BUDGET) { colB.push(t); hB += h + ROW_GAP; }
      else { flush(); colA.push(t); hA += h + ROW_GAP; }
    }
    flush();
    return pages;
  }

  function diagramPage(domain, k, nPages, colA, colB) {
    const color = DOMAIN_COLORS[domain] ?? '#495057';
    const onPage = new Set([...colA, ...colB]);
    const defs = new Map();
    for (const t of onPage) defs.set(t, columns.get(t));

    // stubs for FK targets not on this page (cross-domain or other page)
    const stubs = new Map();
    for (const t of onPage) {
      for (const f of fkByTable.get(t) ?? []) {
        if (!onPage.has(f.rt) && columns.has(f.rt)) {
          if (!stubs.has(f.rt)) stubs.set(f.rt, []);
          stubs.get(f.rt).push(t);
        }
      }
    }
    for (const s of stubs.keys()) defs.set(s, [{ name: 'id', type: 'varchar', pk: true }]);

    // ── positions: 2 fixed columns; stubs fill the leftover of the lighter column ──
    const COL_X = [PAD, PAD + BOX_W + COL_GAP];
    const pos = new Map();
    let canvasH = 0;
    [[colA, COL_X[0]], [colB, COL_X[1]]].forEach(([list, x]) => {
      let y = PAD;
      for (const t of list) {
        const h = boxHeight(defs.get(t));
        pos.set(t, { x, y, w: BOX_W, h, col: x === COL_X[0] ? 0 : 1 });
        y += h + ROW_GAP;
      }
      canvasH = Math.max(canvasH, y);
    });
    // stubs (small boxes) appended to whichever column currently ends higher
    const stubList = [...stubs.keys()].sort((a, b) => stubs.get(b).length - stubs.get(a).length);
    for (const s of stubList) {
      const bottom0 = PAD + colA.reduce((acc, t) => acc + boxHeight(defs.get(t)) + ROW_GAP, 0);
      const bottom1 = PAD + colB.reduce((acc, t) => acc + boxHeight(defs.get(t)) + ROW_GAP, 0);
      const col = bottom0 <= bottom1 ? 0 : 1;
      const y = Math.min(bottom0, bottom1);
      pos.set(s, { x: COL_X[col], y, w: BOX_W, h: boxHeight(defs.get(s)), col });
      if (col === 0) colA.push(s); else colB.push(s);
      canvasH = Math.max(canvasH, y + boxHeight(defs.get(s)) + ROW_GAP);
    }

    // ── edges (child → parent), orthogonal through the central channel ──
    const edges = [];
    for (const t of onPage) {
      for (const f of fkByTable.get(t) ?? []) {
        if (pos.has(f.rt)) edges.push({ from: t, to: f.rt, col: f.c });
      }
    }
    // merge parallel FKs between same pair
    const merged = new Map();
    for (const e of edges) {
      const kk = `${e.from}=>${e.to}`;
      if (!merged.has(kk)) merged.set(kk, { from: e.from, to: e.to, cols: [] });
      merged.get(kk).cols.push(e.col);
    }
    const edgeList = [...merged.values()];

    // distribute exit/entry points on the channel-facing side of each box
    const outs = new Map(), ins = new Map();
    for (const e of edgeList) {
      if (!outs.has(e.from)) outs.set(e.from, []);
      outs.get(e.from).push(e);
      if (!ins.has(e.to)) ins.set(e.to, []);
      ins.get(e.to).push(e);
    }
    const sideY = (box, list, i) => box.y + ((i + 1) * box.h) / (list.length + 1);
    const CH_MIN = PAD + BOX_W + 26, CH_MAX = PAD + BOX_W + COL_GAP - 26;
    edgeList.forEach((e, i) => {
      const a = pos.get(e.from), b = pos.get(e.to);
      const oi = outs.get(e.from).indexOf(e), ii = ins.get(e.to).indexOf(e);
      const y1 = sideY(a, outs.get(e.from), oi);
      const y2 = sideY(b, ins.get(e.to), ii);
      const cx = CH_MIN + ((i * 23) % (CH_MAX - CH_MIN));
      const label = e.cols.length <= 2 ? e.cols.join(', ') : `${e.cols.length} FK`;
      // both endpoints sit on the channel-facing edge of their column → the
      // orthogonal path never crosses any box
      const x1 = a.col === 0 ? a.x + BOX_W : a.x;
      const x2 = b.col === 0 ? b.x + BOX_W : b.x;
      const d = `M ${x1} ${y1} L ${cx} ${y1} L ${cx} ${y2} L ${x2} ${y2}`;
      const ly = (Math.min(y1, y2) + Math.max(y1, y2)) / 2;
      e.path = d;
      e.labelSvg = label
        ? `<text x="${cx + 5}" y="${ly + 4}" font-size="11" fill="#3f4e66" stroke="#ffffff" stroke-width="3.4" paint-order="stroke" font-style="italic">${esc(label)}</text>`
        : '';
    });

    const edgeParts = edgeList.map((e) =>
      `<path d="${e.path}" fill="none" stroke="#8494ab" stroke-width="1.6" opacity="0.8" marker-end="url(#arrow)"/>`).join('\n      ');
    const labelParts = edgeList.map((e) => e.labelSvg).filter(Boolean).join('\n      ');

    // ── entity boxes ──
    const boxes = [];
    for (const [t, p] of pos) {
      const isStub = !onPage.has(t);
      const head = isStub ? '#94a3b8' : color;
      const rows = defs.get(t).map((c) => {
        const fk = !isStub && fkList.some((f) => f.t === t && f.c === c.name);
        const badges = (c.pk ? '<span class="b pk">PK</span>' : '') + (fk ? '<span class="b fk">FK</span>' : '');
        return `<div class="r"><span class="cn">${esc(c.name)}</span><span class="ct">${c.pk ? '<u>' + esc(shortType(c.type)) + '</u>' : esc(shortType(c.type))}</span>${badges}</div>`;
      }).join('');
      const border = isStub ? 'border:1.6px dashed #94a3b8;' : `border:1.6px solid ${color};`;
      const note = isStub ? `<div class="stub">bảng khác — xem trang tương ứng</div>` : '';
      boxes.push(`<div class="ent" style="left:${p.x}px;top:${p.y}px;width:${p.w}px;${border}">
        <div class="eh" style="background:${head}">${esc(t)}</div>${note}${rows}</div>`);
    }

    const width = PAD * 2 + BOX_W * 2 + COL_GAP;
    const height = canvasH + PAD;
    const html = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><title>${esc(DOMAIN_TITLES[domain] ?? domain)} (t.${k})</title>
<style>
  body { background:#fff; color:#111827; font-family:'Segoe UI',system-ui,sans-serif; margin:0; padding:26px 34px; }
  h1 { font-size:23px; margin:0 0 4px; }
  h1 .chip { display:inline-block; width:15px; height:15px; border-radius:4px; background:${color}; vertical-align:-2px; margin-right:10px; }
  .sub { color:#4b5563; font-size:13.5px; margin-bottom:12px; }
  .legend { font-size:12px; color:#4b5563; margin-bottom:14px; }
  .b { font-size:10px; font-weight:700; border-radius:3px; padding:0 4px; margin-left:4px; vertical-align:1px; }
  .pk { background:#1d4ed8; color:#fff; }
  .fk { background:#c2410c; color:#fff; }
  .wrap { position:relative; }
  .ent { position:absolute; background:#fff; border-radius:6px; box-shadow:0 1px 4px rgba(15,23,42,.14); overflow:hidden; }
  .eh { color:#fff; font-weight:700; font-size:15px; padding:4.5px 9px; letter-spacing:.2px; }
  .stub { font-size:10.5px; color:#64748b; padding:2px 9px; background:#f1f5f9; }
  .r { display:flex; align-items:center; font-size:13px; padding:2.5px 9px; line-height:18px; }
  .r:nth-child(even) { background:#f7f9fc; }
  .cn { flex:1; font-family:Consolas,ui-monospace,monospace; font-size:13px; white-space:nowrap; }
  .ct { color:#6b7280; font-size:11px; margin-left:8px; white-space:nowrap; }
</style></head>
<body>
  <h1><span class="chip"></span>${esc(DOMAIN_TITLES[domain] ?? domain)}
      <span style="font-size:14px;color:#6b7280;font-weight:normal"> — trang ${k}/${nPages} · ${onPage.size} bảng${stubs.size ? ` + ${stubs.size} bảng tham chiếu` : ''} · domain <code>${esc(domain)}</code></span></h1>
  <div class="sub">${esc(DOMAIN_DESC[domain] ?? '')}</div>
  <div class="legend"><b>PK</b> khóa chính (kiểu gạch chân) · <b>FK</b> khóa ngoại · nhãn nghiêng bên cạnh kênh dọc = cột FK · mũi tên vuông góc hướng về bảng được tham chiếu · khung đứt nét = bảng ở trang khác</div>
  <div class="wrap" id="wrap" style="width:${width}px;height:${height}px">
    <svg width="${width}" height="${height}" style="position:absolute;left:0;top:0">
      <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8494ab"/></marker></defs>
      ${edgeParts}
    </svg>
    ${boxes.join('\n    ')}
    <svg width="${width}" height="${height}" style="position:absolute;left:0;top:0;pointer-events:none">
      ${labelParts}
    </svg>
  </div>
  <script>
    window.addEventListener('load', () => {
      const w = document.getElementById('wrap');
      window.__READY = { w: Math.ceil(w.offsetWidth) + 68, h: Math.ceil(w.offsetHeight) + 110 };
      document.title = 'OK ' + document.title;
    });
  </script>
</body></html>`;
    const name = `${domain}-${k}`;
    fs.writeFileSync(path.join(OUT_DIR, `${name}.html`), html);
    manifest.pages.push({
      page: name, domain,
      title: `${DOMAIN_TITLES[domain] ?? domain} (t.${k})`,
      tables: onPage.size, stubs: stubs.size,
      size: [Math.ceil(width), Math.ceil(height)],
    });
  }

  for (const domain of domains) {
    const pages = packPages(byDomain.get(domain));
    pages.forEach(([colA, colB], i) => diagramPage(domain, i + 1, pages.length, colA, colB));
    manifest.domains[domain] = { title: DOMAIN_TITLES[domain] ?? domain, tables: byDomain.get(domain).length, color: DOMAIN_COLORS[domain] ?? '#495057', diagrams: pages.length };
  }

  // ── Overview page — elliptical domain map with cross-domain FK flows ──
  const crossFlow = new Map();
  for (const t of business) {
    for (const f of fkByTable.get(t) ?? []) {
      const d1 = domainOf(t), d2 = domainOf(f.rt);
      if (d1 === d2) continue;
      crossFlow.set(`${d1}=>${d2}`, (crossFlow.get(`${d1}=>${d2}`) ?? 0) + 1);
    }
  }
  const flows = [...crossFlow.entries()].map(([kk, v]) => { const [a, b] = kk.split('=>'); return { a, b, v }; }).sort((x, y) => y.v - x.v);
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
  manifest.pages.unshift({ page: 'overview', domain: 'overview', title: 'Sơ đồ tổng quan', tables: business.length, stubs: 0, size: [1340, 1060] });

  fs.writeFileSync(path.join(OUT_DIR, 'report-manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`pages: ${manifest.pages.length}; business tables: ${business.length}`);
  for (const p of manifest.pages) console.log(`  ${p.page}: ${p.tables}+${p.stubs} (${p.size[0]}x${p.size[1]})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
