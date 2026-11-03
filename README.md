# Restaurant Manager — AI-Powered Restaurant POS & Management System

**Offline-first, source-available restaurant POS software** for ordering, kitchen display (KDS), inventory, recipes, staff scheduling, payroll, accounting, delivery, fiscalization, and AI-powered restaurant analytics — delivered by **Kashif**, Restaurant Manager's in-app AI assistant — in one platform.

Restaurant Manager is a **source-available restaurant POS and restaurant management system** built for modern food businesses. It combines point-of-sale ordering, kitchen display systems (KDS), inventory and recipe management, staff scheduling and payroll, accounting, delivery, fiscalization (FBR / PRA), and AI restaurant analytics powered by **Kashif** in one **offline-first** platform.

React · TypeScript · Vite · Bun · MySQL · WebSockets · IndexedDB

## Links

- **Repository (canonical):** <https://github.com/soncnjp181006/restaurant-manager>
- **Documentation index:** [docs/readme.md](docs/readme.md)
- **Settings & language guide:** [docs/user-guide/SETTINGS.md](docs/user-guide/SETTINGS.md)
- **Integrations framework (dev):** [docs/integrations/framework.md](docs/integrations/framework.md)
- **Auth gateway:** [docs/security/GATEWAY.md](docs/security/GATEWAY.md)

---

## Who is Restaurant Manager for?

Restaurant Manager is designed for **restaurants, cafés, coffee shops, bakeries, bars, hotels, cloud kitchens, food courts, catering, and multi-location restaurant groups** that need a full operations stack — not just a cash register.

## Why Restaurant Manager?

Traditional restaurant POS software often depends on cloud connectivity and separate tools for inventory, accounting, staff, delivery, and analytics. Restaurant Manager combines those workflows in one **offline-first, extensible** platform.

- **Source-available** — inspect, modify, extend, and self-host under PSAL
- **Offline-first** — keep selling during internet outages; sync when back online
- **AI-native** — **Kashif** for natural-language reporting, inventory/staff forecasts, and proposed configuration changes; plus AI Import for bulk file uploads
- **Real-time** — WebSocket sync across POS, KDS, manager, and delivery apps
- **Restaurant-specific** — tables, seats, modifiers, recipes, kitchen production, buffet, fiscalization
- **Extensible** — event-driven Integration Manager for fiscal, accounting, logging, and more

---

## Meet Kashif

**Kashif** is Restaurant Manager's AI assistant for managers and back-office staff. Ask questions in plain language and get answers from **live POS data** — never guessed numbers. The same Kashif persona powers the **floating assistant** on back-office screens and the full-page **AI Report**.

**Where Kashif appears**

- **Floating assistant** — Manage, Inventory, Reports, HR, Accounts, Integrations, Tips, and Clock (hidden on cashier POS, KDS, and delivery screens)
- **AI Report** — dedicated reporting page with tables, charts, and analysis formats

**Ask Kashif (read-only, live data)**

- **Sales & service** — today's sales, voids, tips, discounts, coupons, menu mix, unsold items, server speed, staff accountability
- **Orders** — open orders by status, full **order dossier** (items, payments, kitchen, fiscal, prints)
- **Inventory** — stock on hand, purchases, issues, waste, adjustments, transfers, consumption vs issuance, purchase orders, suppliers, locations, **what to buy** (forecast from history, on-hand, holidays, weather, events)
- **Operations** — kitchen routing and station delays, cash/close audit, activity and fraud signals
- **Labor & HR** — labor cost, overtime, attendance, payroll, scheduled vs actual, **staff need forecast**, employee dossier, departments, positions, cost centers, leave
- **Accounts** — trial balance, balance sheet, P&L, cash flow, general ledger, journals, account statements
- **Manage config** — floors, tables, menus, discounts, users, roles, kitchens, printers, workflows, and more

**Tell Kashif what to change (proposals — you review and confirm)**

- **Menu & floor setup** — dishes, categories, modifiers, kitchens, workflows, tables, taxes, order/payment types, discounts (including BOGO), coupons, extras, printers
- **Inventory** — items, locations, suppliers, purchases, issues, waste, adjustments
- **HR** — employees, departments, positions, cost centers, shifts, leave, attendance corrections
- **Accounts** — chart of accounts, journal entries
- **Soft deletes** — dishes and kitchens (proposed, not immediate)

Write proposals use the same review-and-confirm pipeline as **AI Import** — Kashif prepares changes; nothing is saved until you confirm. Tools respect **RBAC** for the signed-in role. Conversations persist per user on this device (IndexedDB). AI usage quotas apply (see AI features below). Rename the assistant via `VITE_AI_ASSISTANT_NAME` (default: `Kashif`).

**Example prompts**

- *Give me a quick business health overview*
- *Compare net sales this week vs last week*
- *How much inventory do I need this Friday and what should I buy?*
- *How many staff do I need this Friday?*
- *Labor cost as a percentage of net sales this week*
- *Profit and loss for this month*
- *Flag order takers with void or discount rates above team average this week*

---

## Restaurant POS & Management Features

### AI restaurant analytics & reporting

- **Natural language analytics** — ask plain-text questions; get visual reports across sales, inventory, accounts, and labor
- **Descriptive analytics** — patterns, anomalies, voids/discounts, performance drivers
- **Sales forecasting** — demand prediction for staffing, purchasing, promotions
- **AI inventory forecasting** — purchase quantity suggestions from history, stock, holidays, weather, events
- **AI staff forecasting** — recommended hours/headcount vs schedule and same-weekday history
- **Order dossier** — full order timeline by ID, number, or invoice (dishes, voids, payments, kitchen, fiscal, prints)
- **Sales vs consumption** — recipe usage vs ledger issuance vs purchases
- **AI Import** — OCR/parse CSV, Excel, PDF, images, clipboard for master data, document lines, journals, HR shifts (create / update / upsert)
- **AI usage controls** — daily/monthly quotas; disable AI entirely

### Restaurant ordering & POS

- **Table-based ordering** — seat assignments, split by seat, multi-order tables
- **Takeaway mode** — pickup queue, customer name/phone/time
- **Order lifecycle** — split / merge / cancel / transfer / refunds
- **Modifiers** — groups, nested modifiers, price overrides, min/max rules
- **Visual menu builder** — dishes, categories, multi-category, tax rules
- **Multiple menus** — breakfast/lunch/dinner, dynamic pricing, delivery menu link
- **Extras & service charges** — fixed/%, rule-based by order type / payment / table
- **Discounts & coupons** — fixed/%, Buy X Get Y, payment-type promos, delivery coupons
- **Closing cycles** — auto check close, shift/day close, enforcement + notifications
- **Tips** — pooling, staff rules, shift allocation
- **Waiter app** — mobile order entry, table select, touch-optimized
- **Manager app** — dashboard, analytics, config, branch reporting

### Kitchen Display System (KDS)

- **Multi-stage KDS** — custom prep stages, station routing, status (received → served), recall
- **Grouped addons & voice alerts** — denser ticket grid; spoken alerts for new orders/addons

### Restaurant inventory & recipe management

- **Location-based stock** — stores/kitchens as inventory locations
- **Stock transfers** — location-to-location with ledger posting
- **Kitchen reconciliation** — theoretical (recipe × sales) vs actual by location
- **Kitchen production** — batch prep, yields, ingredient consumption
- **Buffet production** — portion planning, session close, replenishment
- **Recipe deduction** — stock-aware menus; auto deduct on sale
- **Documents** — purchase orders, purchases/returns, issues/returns, adjustments, waste
- **Inventory dashboard** — transfers, production, buffet, runout forecast, low-stock alerts
- **Suppliers** — supplier master + performance

### Restaurant staff scheduling & payroll

- **Shift scheduling** — create/assign schedules; **print schedule roster** (week grid, PDF/Excel)
- **Clock-in / clock-out** — work hours, late/early detection
- **Attendance** — history logs; bulk AI Import (pending until manager approve)
- **Leave & holidays** — paid/unpaid leave in payroll
- **Pay profiles** — hourly, daily wage, or flat period (monthly/weekly/contract)
- **Payroll runs** — preview, overrides, approve/post
- **Org structure** — employees, departments, positions, cost centers, branch assignment
- **RBAC** — admin, manager, waiter, kitchen, delivery, custom roles; protected modules (web + mobile)

### Restaurant accounting & payments

- **Internal ledger** — chart of accounts, journals, GL / TB / BS / P&L style reporting
- **Closing & reconciliation** — checks, shifts, days; audit-ready payment trail
- **Payment gateways** — Stripe, PayPal, JazzCash, M-Pesa, Telebirr, Razorpay (sandbox/live, webhooks)
- **QuickBooks Online** — OAuth; sync sales, payments, customers, refunds; journals for inventory/payroll/waste; import COA / vendors / tax codes
- **Fiscal (Pakistan)** — **FBR** and **PRA** invoice submission at settlement (API-proxied); receipt logos / QR

### Restaurant delivery management

- **Delivery app** — dispatch, driver tracking, Google Maps, realtime customer updates
- **Smart coupons** — fixed/%/free shipping, usage limits, time windows, first-order rules

### Integration Manager

- **Plugin hub** — enable/configure providers without coupling POS screens ([framework docs](docs/integrations/framework.md))
- **Event-driven** — fan-out sales, inventory, HR, accounts, ops, lifecycle, and `EntityChanged` master-data events
- **Offline queue** — retries, dedupe, IndexedDB persistence; settlement not blocked by slow APIs
- **Health & audit** — provider health, job queue UI, audit log
- **Integrations UI** — providers, configuration, queue, health panels
- **Permissions** — toggle provider, open/save configuration (manager PIN when missing)
- **Providers (shipped):**
  - **FBR Fiscalization** — FBR invoices at settlement
  - **PRA Fiscalization** — PRA invoices at settlement
  - **Internal Accounting** — draft journals from sales, refunds, payroll, purchases, waste, issues, transfers, production
  - **Internal Inventory** — inventory integration hooks
  - **QuickBooks Online** — external accounting sync (see above)
  - **Event Logger** — all/filtered events → console or HTTP (bearer / API key / basic / JWT)

### Offline-first platform

- **Offline-first** — IndexedDB + realtime WebSocket sync; automatic cloud backups
- **Auth gateway** — session JWT; Surreal credentials not shipped to browser ([GATEWAY.md](docs/security/GATEWAY.md))
- **ESC/POS printing** — USB, Serial, Network, Bluetooth; kitchen tickets, receipts, delivery slips, pre-sale bills, sales summaries; custom logos
- **Multi-lingual** — English, Tiếng Việt; live language switch
- **Tech stack** — React + TypeScript, Bun + Vite, MySQL (via the wire-compatible dbproxy service), WebSockets

---

## Quick Start

Full install and first-sale walkthrough: **[Documentation → Get started](docs/readme.md)**

```bash
git clone https://github.com/soncnjp181006/restaurant-manager
cd restaurant-manager
cp .env.example .env
cp api/.env.example api/.env
cp gateway/.env.example gateway/.env
cp payments/.env.example payments/.env
cp tracking-api/.env.example tracking-api/.env
bun install
docker compose up -d
```

Copied `.env` files include **local-dev** database credentials (`restaurant` / `CHANGE_ME_BEFORE_DEPLOY`). Change `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_ROOT_PASSWORD`, `SURREAL_USER`, `SURREAL_PASS` (the dbproxy RPC root credentials), and `GATEWAY_JWT_SECRET` before any non-localhost deploy — `GATEWAY_JWT_SECRET` ships **blank** on purpose, so generate one (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`). `root`/`root` is rejected.

**Auth gateway (default):** SPA uses port **3142**, never the database port (**8000** dbproxy / **3306** MySQL) directly. Set `VITE_GATEWAY_URL` / `VITE_DB_WEBDOCKET` to the gateway; do **not** set `VITE_DB_USER` / `VITE_DB_PASS` in the browser bundle. Details and rollback: [docs/security/GATEWAY.md](docs/security/GATEWAY.md).

**MySQL everywhere:** the whole system of record is MySQL — one `records` JSON store plus its metadata and change-log tables, all owned by the wire-compatible `dbproxy` service (see [docs/MIGRATION-MYSQL.md](docs/MIGRATION-MYSQL.md)). The tracking / activity log can additionally be mirrored into a flat `tracking_events` table for SQL analytics — leave `TRACKING_MYSQL_*` blank and the mirror stays inert. Design, limits, and how to enable it: [docs/adr/0006-mysql-tracking-mirror.md](docs/adr/0006-mysql-tracking-mirror.md).

### Migrating a legacy SurrealDB datastore to MySQL

An install that still runs SurrealDB keeps its data in `./database` (surrealkv). Move it into MySQL with the one-shot migration script — it starts a temporary SurrealDB, copies every table through the dbproxy (so record links and datetimes keep their wire types), applies `migrations/latest.surql`, and prints a per-table count comparison:

```bash
# 1. start a temporary SurrealDB serving the legacy datastore (adjust paths/ports)
docker volume create rm-surreal-data
docker run --rm -v rm-surreal-data:/data -v "$PWD/database:/src" alpine sh -c "cp -r /src/. /data/ && chmod -R u+rwX /data && rm -f /data/LOCK"
docker run --rm -d --name rm-surreal-migrate -p 18000:8000 --user 0:0 -v rm-surreal-data:/database \
  surrealdb/surrealdb:v3.0.5 start --user restaurant --pass <pass> surrealkv://database --bind 0.0.0.0:8000

# 2. start the dbproxy with events disabled for a clean import
cd dbproxy && DB_DISABLE_EVENTS=1 DB_HOST=127.0.0.1 DB_PORT=<mysql-port> DB_NAME=restaurant_manager \
  DB_USER=<user> DB_PASS=<pass> DB_ROOT_USER=<user> DB_ROOT_PASS=<pass> DB_TOKEN_SECRET=<jwt-secret> \
  DBPROXY_PORT=18001 node src/server.mjs & cd ..

# 3. migrate + apply schema + verify per-table counts
SRC_URL=ws://127.0.0.1:18000/rpc DST_URL=ws://127.0.0.1:18001/rpc node migrations/scripts/migrate-surreal-to-mysql.cjs
```

### Migrating an existing PostgreSQL store to MySQL

An install that ran the previous engine keeps everything in six PostgreSQL tables. Export them with `psql` and let the mover load and **verify** the copy (row counts, every cell compared canonically, and the `change_log` watermark): the exact commands are in the header of [`migrations/scripts/migrate-pg-to-mysql.cjs`](migrations/scripts/migrate-pg-to-mysql.cjs).

Full procedure and verification steps: [docs/MIGRATION-MYSQL.md](docs/MIGRATION-MYSQL.md).

Browser-side offline data (PosStore, integration queue/secrets, AI history) is copied automatically on first launch by `src/lib/legacy-storage.ts`, which leaves the old store in place as a fallback. Active sessions end once, because the gateway's JWT issuer and the session cookie names changed. Full rationale: [docs/adr/0007-full-brand-rename.md](docs/adr/0007-full-brand-rename.md).

---

## Roadmap

1. [ ] Multi-branch synchronization improvements
2. [ ] Extend AI to CRUD / autonomous operations
3. [ ] QR code and self-ordering
4. [ ] Tap-to-pay on mobile apps
5. [ ] Targeted sales / performance
6. [ ] Multi-currency support
7. [ ] Loyalty module

---

## Contributing

Fork → feature branch → PR. Stars help visibility.

---

## License

**Restaurant Manager Source Available License (RMSAL) v1.0** — no `LICENSE` file is committed in this repository yet, so the summary below is the only licence text available; `package.json` still says `SEE LICENSE IN LICENSE` and that file has to be added (or the claim rewritten) before publishing.

Restaurant Manager is **source-available** (not OSI “open source”): you may view, study, clone, fork, modify; build plugins/connectors; run your own business (any locations); hire contractors to maintain it.

- No selling/reselling the Software as a product; no hosted multi-tenant SaaS; no white-label competing POS.

Commercial license / white-label / OEM: open an issue on the canonical repository — **<https://github.com/soncnjp181006/restaurant-manager/issues>**.
