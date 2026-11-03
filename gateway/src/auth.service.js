'use strict';

const { getClient } = require('./surreal-client');

/** SurrealDB 3.x: string record ids must use type::record(), not WHERE id = $id. */
function firstQueryRow(result) {
  if (!Array.isArray(result) || result.length === 0) return null;
  const top = result[0];
  if (Array.isArray(top)) return top[0] ?? null;
  if (top && typeof top === 'object') return top;
  return null;
}

function serializeUser(row) {
  if (!row) return null;
  const { password: _password, ...safe } = row;
  const id = safe.id?.toString?.() || String(safe.id);
  const role = safe.user_role;
  const shift = safe.user_shift;

  return {
    ...safe,
    id,
    user_role: role
      ? {
          ...role,
          id: role.id?.toString?.() || role.id,
        }
      : role,
    user_shift: shift
      ? {
          ...shift,
          id: shift.id?.toString?.() || shift.id,
        }
      : shift,
  };
}

async function authenticatePosUser({ method, login, password }) {
  const db = await getClient();
  const cleanLogin = String(login || '').trim();
  const cleanPass = String(password || '');

  if (method === 'pin') {
    if (cleanLogin.length !== 4) {
      return null;
    }
  } else if (method === 'form') {
    if (!cleanLogin || !cleanPass) {
      return null;
    }
  } else {
    return null;
  }

  const query =
    method === 'pin'
      ? `SELECT * FROM user WHERE login = $login AND deleted_at = NONE AND (login_method = 'pin' OR login_method = NONE) AND crypto::bcrypt::compare(password, $password) = true FETCH user_role, user_shift`
      : `SELECT * FROM user WHERE login = $login AND deleted_at = NONE AND login_method = 'form' AND crypto::bcrypt::compare(password, $password) = true FETCH user_role, user_shift`;

  const result = await db.query(query, {
    login: cleanLogin,
    password: method === 'pin' ? cleanLogin : cleanPass,
  });

  const rows = Array.isArray(result) ? result[0] : result;
  const user = Array.isArray(rows) ? rows[0] : null;
  if (!user) return null;

  let fetchedRole = user.user_role;
  const roleId =
    typeof user.user_role === 'object' ? user.user_role?.id : user.user_role;

  if (roleId) {
    const roleResult = await db.query(
      `SELECT * FROM ONLY type::record($roleId) WHERE deleted_at = NONE`,
      { roleId: String(roleId) }
    );
    const roleRow = firstQueryRow(roleResult) || (Array.isArray(roleResult) ? roleResult[0] : null);
    if (roleRow && typeof roleRow === 'object') {
      fetchedRole = roleRow;
    }
  }

  const roles = fetchedRole?.roles
    ? [...new Set(fetchedRole.roles || [])]
    : [];

  return serializeUser({
    ...user,
    user_role: fetchedRole || user.user_role,
    roles,
  });
}

async function getUserRoleModules(userId) {
  if (!userId) return [];
  const db = await getClient();
  const result = await db.query(
    `SELECT * FROM ONLY type::record($userId) WHERE deleted_at = NONE FETCH user_role`,
    { userId: String(userId) }
  );
  const user = firstQueryRow(result);
  if (!user) return [];

  let fetchedRole = user.user_role;
  const roleId =
    typeof user.user_role === 'object' ? user.user_role?.id : user.user_role;

  if (roleId && (!fetchedRole || !Array.isArray(fetchedRole.roles))) {
    const roleResult = await db.query(
      `SELECT * FROM ONLY type::record($roleId) WHERE deleted_at = NONE`,
      { roleId: String(roleId) }
    );
    const roleRow = firstQueryRow(roleResult) || (Array.isArray(roleResult) ? roleResult[0] : null);
    if (roleRow && typeof roleRow === 'object') {
      fetchedRole = roleRow;
    }
  }

  return fetchedRole?.roles ? [...new Set(fetchedRole.roles.map(String))] : [];
}

function hasSecurityAlertsAccess(roleModules) {
  if (!Array.isArray(roleModules)) return false;
  return roleModules.some((r) => {
    const s = String(r);
    return (
      s === 'admin' ||
      s === 'super_admin' ||
      s === 'admin.*' ||
      s === 'admin.security_alerts' ||
      s.startsWith('admin.')
    );
  });
}

// ---------------------------------------------------------------------------
// First-run bootstrap: when the `user` table is empty the login screen accepts
// the setup PIN (0000) and the app forces creating an admin account.
// ---------------------------------------------------------------------------

const BOOTSTRAP_PIN = '0000';
const BOOTSTRAP_ROLE_ID = 'user_role:bootstrap_master';
const BOOTSTRAP_ROLE_NAME = 'Master';

/** Full module list for the bootstrap admin role — captured from the live
 *  Master role before the legacy accounts were wiped (see
 *  DOCKER-UI-TEST-REPORT.md §9.5). */
const BOOTSTRAP_ROLE_MODULES = ["menu", "menu.change_table", "summary", "summary.print", "summary.product_mix", "summary.server_sales", "Products Summary", "closing", "kitchen", "delivery", "Order Management", "delivery.areas", "delivery.settings", "settings.menus", "settings.printers", "riders", "tips.calculation", "tips.payout", "settings", "settings.service_charges", "delivery.orders", "closing.edit", "settings.auto_check_close", "settings.closing_cycle", "accounts", "accounts.chart_of_accounts", "accounts.account_groups", "accounts.journal_entries", "accounts.general_ledger", "accounts.trial_balance", "accounts.balance_sheet", "accounts.profit_loss", "accounts.cash_flow", "accounts.customer_statement", "accounts.supplier_statement", "hr", "hr.dashboard", "hr.employees", "hr.departments", "hr.positions", "hr.cost_centers", "hr.pay_profiles", "hr.pay_rules", "hr.scheduling", "hr.attendance", "hr.leave", "hr.holidays", "hr.payroll_periods", "hr.payroll_runs", "hr.documents", "hr.performance", "integrations", "integrations.health", "integrations.queue", "settings.show_inclusive_prices", "reports", "reports.delivery_density", "reports.cash_closing", "reports.sales_dashboard", "reports.inventory_dashboard", "reports.sales_hourly_labour", "reports.sales_hourly_labour_weekly", "reports.server_sales", "reports.sales_summary", "reports.sales_summary_2", "reports.sales_weekly", "tips", "reports.tips", "reports.advanced_sales", "reports.discount", "reports.tax", "reports.coupon", "reports.voids", "reports.merge_orders", "reports.split_orders", "reports.order_life_cycle", "reports.expense", "reports.activity", "reports.product_mix_weekly", "reports.product_mix_summary", "reports.products_hourly", "reports.detailed_inventory", "reports.purchase", "reports.purchase_return", "reports.issue", "reports.issue_return", "reports.waste", "reports.consumption", "reports.sale_vs_inventory", "reports.production", "reports.buffet", "reports.ai", "reports.labor_dashboard", "reports.daily_labor_cost", "reports.weekly_labor_cost", "reports.monthly_labor_cost", "reports.employee_labor_cost", "reports.department_labor_cost", "reports.cost_center_labor_cost", "reports.average_hourly_cost", "reports.labor_percent", "reports.sales_per_labor_hour", "reports.revenue_per_employee", "reports.overtime", "reports.attendance", "reports.late_arrival", "reports.absence", "reports.leave", "reports.holiday_cost", "reports.scheduled_vs_actual", "reports.manager_approval", "reports.top_labor_cost_employees", "reports.top_overtime_employees", "reports.payroll_summary", "reports.payroll_details", "reports.labor_trend", "reports.labor_forecast_dataset", "order_display", "settings.access_control", "inventory.locations", "settings.inventory", "settings.auto_clock_out", "settings.session_security", "inventory", "inventory.current_inventory", "reports.current_inventory", "inventory.items", "inventory.suppliers", "inventory.item_categories", "inventory.item_groups", "inventory.purchase_orders", "inventory.purchase_orders.update", "inventory.purchase_orders.delete", "inventory.purchase_orders.approve", "inventory.purchases", "inventory.purchases.update", "inventory.purchases.delete", "inventory.purchase_returns", "inventory.purchase_returns.update", "inventory.purchase_returns.delete", "inventory.issues", "inventory.issues.update", "inventory.issues.delete", "inventory.issue_returns", "inventory.issue_returns.update", "inventory.issue_returns.delete", "inventory.wastes", "inventory.wastes.update", "inventory.wastes.delete", "inventory.adjustments", "hr.adjustments", "inventory.adjustments.update", "inventory.adjustments.delete", "inventory.stock_transfers", "inventory.stock_transfers.update", "inventory.kitchen_reconciliation", "reports.kitchen_reconciliation", "inventory.production_recipes", "inventory.production", "inventory.production_history", "inventory.buffet_menus", "inventory.buffet_sessions", "reports.purchase_order", "settings.print_options", "orders", "orders.cancel", "orders.split_by_seats", "orders.split_by_items", "orders.split_by_amount", "orders.merge", "orders.refund", "orders.print_final", "orders.print_temp", "orders.override_print_limit", "orders.open_cash_drawer", "orders.apply_tax", "orders.apply_discount", "orders.apply_coupon", "orders.apply_service_charges", "orders.apply_tips", "orders.change_extras", "orders.complete", "orders.complete_payment", "orders.update_payment", "orders.move_table", "orders.remote_payment_create", "orders.remote_payment_verify", "reports.order_fiscal", "settings.currency_symbol", "settings.branding", "orders.print_kot", "integrations.providers", "integrations.configuration", "integrations.toggle_provider", "integrations.open_configuration", "integrations.save_configuration", "reports.order_receipt", "reports.schedule_roster", "admin.gift_cards", "admin.marketing", "admin.reservations", "admin.currencies", "admin.kds", "admin.reorder", "reports.forecast", "reports.menu_optimization", "reports.sentiment", "reports.waste_intelligence", "reports.scheduling_optimization", "reports.cash_flow", "reports.vendor_performance", "reports.table_turnover", "reports.dynamic_pricing", "reports.forecast_accuracy", "reports.ai_command_center", "reports.anomaly_alerts", "reports.customer_clv", "reports.churn_prediction", "reports.promo_effectiveness", "reports.server_performance", "reports.competitor_monitoring", "reports.food_cost_trends", "reports.recipe_optimization", "reports.segmentation", "reports.labor_optimization", "reports.delivery_analytics", "reports.peak_hour", "reports.tip_analytics", "reports.revpash", "reports.customer_journey", "reports.seasonal_trends", "reports.guest_preferences", "reports.shrinkage_detection", "reports.revenue_forecast", "reports.no_show_prediction", "reports.order_fraud", "reports.food_safety", "reports.energy_optimization", "reports.staff_turnover", "reports.yield_variance", "reports.kitchen_bottleneck", "reports.win_back", "reports.chargeback_risk", "reports.price_elasticity", "reports.promo_abuse", "reports.menu_pairing", "reports.wait_prediction", "reports.promo_forecast", "reports.clv_trajectory", "reports.spoilage_prediction", "reports.visit_cadence", "reports.recipe_substitution", "reports.training_need", "reports.seating_optimization", "reports.satisfaction_prediction", "reports.abandoned_cart", "tableside", "admin", "admin.dishes", "admin.dishes.create", "admin.dishes.update", "admin.dishes.delete", "admin.dishes.import", "admin.menus", "admin.menus.create", "admin.menus.update", "admin.menus.delete", "admin.categories", "admin.categories.create", "admin.categories.update", "admin.categories.delete", "admin.categories.import", "admin.modifier_groups", "admin.modifier_groups.create", "admin.modifier_groups.update", "admin.modifier_groups.delete", "admin.modifier_groups.import", "admin.tables", "admin.tables.create", "admin.tables.update", "admin.tables.delete", "admin.tables.import", "admin.floors", "admin.floors.create", "admin.floors.update", "admin.floors.delete", "admin.floors.import", "admin.discounts", "admin.discounts.create", "admin.discounts.update", "admin.discounts.delete", "admin.coupons", "admin.coupons.create", "admin.coupons.update", "admin.coupons.delete", "admin.kitchens", "admin.kitchens.create", "admin.kitchens.update", "admin.kitchens.delete", "admin.kitchens.import", "admin.workflows", "admin.workflows.create", "admin.workflows.update", "admin.workflows.delete", "admin.printers", "admin.printers.create", "admin.printers.update", "admin.printers.delete", "admin.print_settings", "admin.print_settings.update", "admin.order_types", "admin.order_types.create", "admin.order_types.update", "admin.order_types.delete", "admin.order_types.import", "admin.payment_types", "admin.payment_types.create", "admin.payment_types.update", "admin.payment_types.delete", "admin.payment_types.import", "admin.extras", "admin.extras.create", "admin.extras.update", "admin.extras.delete", "admin.extras.import", "admin.taxes", "admin.taxes.create", "admin.taxes.update", "admin.taxes.delete", "admin.taxes.import", "admin.users", "admin.users.create", "admin.users.update", "admin.users.delete", "admin.roles", "admin.roles.create", "admin.roles.update", "admin.roles.delete", "admin.shifts", "admin.shifts.create", "admin.shifts.update", "admin.shifts.delete", "admin.tips_definition", "admin.tips_definition.create", "admin.tips_definition.update", "admin.tips_definition.delete", "admin.security_alerts", "settings.translate_receipts", "settings.number_policy", "admin.catalog_publish"];

async function countUsers() {
  const db = await getClient();
  const result = await db.query('SELECT * FROM user LIMIT 1');
  const rows = Array.isArray(result) ? result[0] : result;
  return Array.isArray(rows) ? rows.length : 0;
}

/** True when the app has no users at all — the first-run bootstrap state. */
async function needsBootstrap() {
  return (await countUsers()) === 0;
}

/**
 * First-run identity for PIN 0000: only valid while the user table is empty.
 * The session it produces is a placeholder — the app must finish the admin
 * setup wizard before anything else can be used.
 */
async function authenticateBootstrapUser({ login }) {
  if (String(login || '') !== BOOTSTRAP_PIN) return null;
  if (!(await needsBootstrap())) return null;
  return {
    bootstrap: true,
    id: 'bootstrap',
    login: BOOTSTRAP_PIN,
    first_name: 'Setup',
    login_method: 'pin',
    user_role: { id: BOOTSTRAP_ROLE_ID, name: BOOTSTRAP_ROLE_NAME, roles: [] },
    roles: [],
  };
}

function assertBootstrapAdminInput({ name, pin }) {
  const cleanName = String(name || '').trim();
  if (!cleanName || cleanName.length > 80) {
    throw Object.assign(new Error('Admin name is required (max 80 characters)'), { status: 400 });
  }
  if (!/^\d{4}$/.test(String(pin || ''))) {
    throw Object.assign(new Error('PIN must be exactly 4 digits'), { status: 400 });
  }
  return { cleanName, pin: String(pin) };
}

/**
 * Create the first admin account (server-side hashing via dbproxy's
 * crypto::bcrypt::generate). Only allowed while the user table is still
 * empty — once an admin exists the bootstrap is closed for good.
 */
async function createBootstrapAdmin({ name, pin }) {
  if (!(await needsBootstrap())) {
    throw Object.assign(new Error('An admin account already exists — bootstrap is closed'), { status: 409 });
  }
  const { cleanName, pin: cleanPin } = assertBootstrapAdminInput({ name, pin });

  const db = await getClient();
  // Re-check after the awaits above to narrow the bootstrap window.
  if (!(await needsBootstrap())) {
    throw Object.assign(new Error('An admin account already exists — bootstrap is closed'), { status: 409 });
  }

  await db.query(
    `UPSERT type::record('user_role', 'bootstrap_master') SET
       name = $name,
       roles = $roles,
       deleted_at = NONE`,
    { name: BOOTSTRAP_ROLE_NAME, roles: BOOTSTRAP_ROLE_MODULES },
  );

  await db.query(
    `CREATE user SET
       first_name = $name,
       login = $login,
       password = crypto::bcrypt::generate($pin, 10),
       user_role = type::record('user_role', 'bootstrap_master'),
       login_method = 'pin'`,
    { name: cleanName, login: cleanPin, pin: cleanPin },
  );

  const created = await db.query(
    `SELECT * FROM user WHERE login = $login AND deleted_at = NONE AND login_method = 'pin' FETCH user_role LIMIT 1`,
    { login: cleanPin },
  );
  const rows = Array.isArray(created) ? created[0] : created;
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) {
    throw Object.assign(new Error('Admin created but could not be read back'), { status: 500 });
  }
  return serializeUser(row);
}

module.exports = {
  authenticatePosUser,
  getUserRoleModules,
  hasSecurityAlertsAccess,
  needsBootstrap,
  authenticateBootstrapUser,
  createBootstrapAdmin,
};
