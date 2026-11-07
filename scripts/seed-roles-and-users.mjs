import { Surreal } from 'surrealdb';

const db = new Surreal();

const ROLES = [
  {
    id: 'user_role:role_manager',
    name: 'Manager',
    roles: [
      "menu", "menu.change_table", "orders", "orders.cancel", "orders.split_by_seats",
      "orders.split_by_items", "orders.split_by_amount", "orders.merge", "orders.refund",
      "orders.print_final", "orders.print_temp", "orders.print_kot", "orders.override_print_limit",
      "orders.open_cash_drawer", "orders.apply_tax", "orders.apply_discount", "orders.apply_coupon",
      "orders.apply_service_charges", "orders.change_extras", "orders.complete", "orders.complete_payment",
      "orders.update_payment", "orders.move_table", "summary", "summary.print", "summary.product_mix",
      "summary.server_sales", "kitchen", "closing", "closing.edit", "inventory", "inventory.current_inventory",
      "inventory.items", "inventory.suppliers", "inventory.item_categories", "inventory.item_groups",
      "inventory.locations", "inventory.purchase_orders", "inventory.purchase_orders.update",
      "inventory.purchase_orders.delete", "inventory.purchase_orders.approve", "inventory.purchases",
      "inventory.purchases.update", "inventory.purchases.delete", "inventory.purchase_returns",
      "inventory.purchase_returns.update", "inventory.purchase_returns.delete", "inventory.issues",
      "inventory.issues.update", "inventory.issues.delete", "inventory.issue_returns",
      "inventory.issue_returns.update", "inventory.issue_returns.delete", "inventory.wastes",
      "inventory.wastes.update", "inventory.wastes.delete", "inventory.adjustments",
      "inventory.adjustments.update", "inventory.adjustments.delete", "inventory.stock_transfers",
      "inventory.stock_transfers.update", "hr", "hr.dashboard", "hr.employees", "hr.departments",
      "hr.positions", "hr.cost_centers", "hr.scheduling", "hr.attendance", "hr.leave", "hr.holidays",
      "reports", "reports.cash_closing", "reports.sales_dashboard", "reports.inventory_dashboard",
      "reports.sales_hourly_labour", "reports.sales_server", "reports.sales_summary", "reports.activity",
      "reports.current_inventory", "clock"
    ]
  },
  {
    id: 'user_role:role_waiter',
    name: 'Waiter',
    roles: [
      "menu", "menu.change_table", "orders", "orders.print_kot", "orders.print_temp",
      "orders.move_table", "clock"
    ]
  },
  {
    id: 'user_role:role_kitchen',
    name: 'Kitchen',
    roles: [
      "kitchen", "order_display", "clock"
    ]
  },
  {
    id: 'user_role:role_cashier',
    name: 'Cashier',
    roles: [
      "menu", "orders", "orders.complete", "orders.complete_payment", "orders.apply_discount",
      "orders.apply_coupon", "orders.apply_tax", "orders.refund", "orders.print_final",
      "orders.open_cash_drawer", "summary", "closing", "closing.edit", "clock"
    ]
  },
  {
    id: 'user_role:role_inventory',
    name: 'Inventory Keeper',
    roles: [
      "inventory", "inventory.current_inventory", "inventory.items", "inventory.suppliers",
      "inventory.item_categories", "inventory.item_groups", "inventory.locations",
      "inventory.purchase_orders", "inventory.purchase_orders.update", "inventory.purchase_orders.approve",
      "inventory.purchases", "inventory.purchases.update", "inventory.issues", "inventory.issues.update",
      "inventory.wastes", "inventory.wastes.update", "inventory.adjustments", "inventory.adjustments.update",
      "inventory.stock_transfers", "inventory.stock_transfers.update", "reports", "reports.current_inventory",
      "reports.detailed_inventory", "reports.purchase", "reports.issue", "reports.waste", "clock"
    ]
  },
  {
    id: 'user_role:role_accountant',
    name: 'Accountant',
    roles: [
      "accounts", "accounts.chart_of_accounts", "accounts.account_groups", "accounts.journal_entries",
      "accounts.general_ledger", "accounts.trial_balance", "accounts.balance_sheet", "accounts.profit_loss",
      "accounts.cash_flow", "accounts.customer_statement", "accounts.supplier_statement", "reports",
      "reports.sales_summary", "reports.expense", "clock"
    ]
  }
];

const USERS = [
  {
    first_name: 'Manager 1',
    login: '1111',
    pin: '1111',
    role_id: 'user_role:role_manager'
  },
  {
    first_name: 'Waiter 1',
    login: '2222',
    pin: '2222',
    role_id: 'user_role:role_waiter'
  },
  {
    first_name: 'Kitchen 1',
    login: '3333',
    pin: '3333',
    role_id: 'user_role:role_kitchen'
  },
  {
    first_name: 'Cashier 1',
    login: '4444',
    pin: '4444',
    role_id: 'user_role:role_cashier'
  },
  {
    first_name: 'Inventory 1',
    login: '6666',
    pin: '6666',
    role_id: 'user_role:role_inventory'
  },
  {
    first_name: 'Accountant 1',
    login: '7777',
    pin: '7777',
    role_id: 'user_role:role_accountant'
  }
];

async function main() {
  await db.connect('ws://127.0.0.1:8007/rpc', {
    namespace: 'restaurant_manager',
    database: 'restaurant_manager',
    authentication: {
      username: 'restaurant',
      password: 'fc3ec04f8907d7032df738bae6951b928d83'
    }
  });

  console.log('Seeding Roles...');
  for (const r of ROLES) {
    await db.query(`
      UPSERT type::record($roleId) SET
        name = $name,
        roles = $roles,
        deleted_at = NONE
    `, {
      roleId: r.id,
      name: r.name,
      roles: r.roles
    });
    console.log(`Role [${r.name}] seeded.`);
  }

  console.log('Seeding Users...');
  for (const u of USERS) {
    // Delete existing user with same login if any
    await db.query(`DELETE FROM user WHERE login = $login`, { login: u.login });
    await db.query(`
      CREATE user SET
        first_name = $name,
        login = $login,
        password = crypto::bcrypt::generate($pin, 10),
        user_role = type::record($roleId),
        login_method = 'pin'
    `, {
      name: u.first_name,
      login: u.login,
      pin: u.pin,
      roleId: u.role_id
    });
    console.log(`User [${u.first_name}] (PIN: ${u.pin}) seeded.`);
  }

  // Also activate default menu so it shows up in POS
  await db.query(`UPDATE menu SET active = true WHERE active = false`);
  console.log('Activated menus.');

  // Set global setting for menus so POS ordering loads dishes
  const [menus] = await db.query(`SELECT id, name FROM menu WHERE active = true`);
  const activeMenus = Array.isArray(menus) ? menus : [];
  if (activeMenus.length > 0) {
    const menuIds = activeMenus.map(m => m.id);
    await db.query(`
      UPSERT type::record('setting', 'menus_global') SET
        key = 'menus',
        values = $values,
        is_global = true
    `, {
      values: menuIds
    });
    console.log('Global menus setting saved.');
  }

  await db.close();
  console.log('Setup finished successfully!');
}

main().catch(err => {
  console.error('Seed error:', err);
  process.exit(1);
});
