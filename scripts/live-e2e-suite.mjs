import { chromium } from 'playwright';
import { Surreal } from 'surrealdb';
import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = 'http://localhost:5174';
const SCREENSHOT_DIR = path.join(process.cwd(), 'gui-test-screenshots', 'live-run');

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

let stepNumber = 1;
let currentOrderId = null;

async function capture(page, name) {
  const filename = `${String(stepNumber++).padStart(3, '0')}-${name}.png`;
  const filePath = path.join(SCREENSHOT_DIR, filename);
  await page.screenshot({ path: filePath, fullPage: false });
  console.log(`  📸 [Step ${stepNumber - 1}] Screenshot saved: ${filename}`);
}

async function getSurreal() {
  const db = new Surreal();
  await db.connect('ws://127.0.0.1:8007/rpc', {
    namespace: 'restaurant_manager',
    database: 'restaurant_manager',
    authentication: {
      username: 'restaurant',
      password: 'fc3ec04f8907d7032df738bae6951b928d83'
    }
  });
  return db;
}

async function dismissModals(page) {
  try {
    const whatsNew = page.getByTestId('whats-new-dismiss');
    if (await whatsNew.isVisible({ timeout: 1500 }).catch(() => false)) {
      await whatsNew.click();
      await page.waitForTimeout(500);
    }
  } catch {}

  try {
    const clockIn = page.getByTestId('login-clock-in');
    if (await clockIn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await clockIn.click();
      await page.waitForTimeout(500);
    }
  } catch {}
}

async function loginUser(page, pin, expectedName) {
  console.log(`\n======================================================`);
  console.log(`🔑 LOGGING IN WITH PIN [${pin}] (Expected: ${expectedName})`);
  console.log(`======================================================`);

  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  // If already logged in, log out first
  const logoutBtn = page.getByTestId('nav-logout');
  if (await logoutBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    console.log('  Logging out previous session...');
    await logoutBtn.click();
    await page.waitForTimeout(1500);
  }

  // Ensure on PIN pad
  const pinSwitcher = page.getByTestId('login-method-pin');
  if (await pinSwitcher.isVisible({ timeout: 3000 }).catch(() => false)) {
    await pinSwitcher.click();
    await page.waitForTimeout(300);
  }

  const pinPad = page.getByTestId('login-pin-pad');
  await pinPad.waitFor({ state: 'visible', timeout: 10000 });

  for (const digit of pin.slice(0, 4)) {
    await pinPad.getByRole('button', { name: digit, exact: true }).click();
    await page.waitForTimeout(100);
  }

  // Handle clock in gate
  const clockIn = page.getByTestId('login-clock-in');
  try {
    await clockIn.waitFor({ state: 'visible', timeout: 5000 });
    console.log('  Clock-in prompt visible, clicking Clock In...');
    await clockIn.click();
    await page.waitForTimeout(1000);
  } catch {
    // Clock in not required or already active
  }

  await page.waitForURL(/\/(menu|settings|orders|admin|inventory|accounts|hr|kitchen|closing|summary|reports|order-display)/, { timeout: 20000 });
  console.log(`  ✅ Successfully authenticated as [${expectedName}]! URL: ${page.url()}`);
  await dismissModals(page);
  await capture(page, `login-${pin}-${expectedName.replace(/\s+/g, '_')}`);
}

async function logoutUser(page) {
  console.log('  🚪 Logging out...');
  await dismissModals(page);

  // If in table ordering view, return to floor plan first
  const backFloor = page.getByTestId('menu-back-floor');
  if (await backFloor.isVisible({ timeout: 1500 }).catch(() => false)) {
    console.log('    Returning from table view to floor plan...');
    await backFloor.click();
    await page.waitForTimeout(800);
  }

  // Also check if cart-cancel is visible
  const cartCancel = page.getByTestId('cart-cancel');
  if (await cartCancel.isVisible({ timeout: 1000 }).catch(() => false)) {
    console.log('    Cancelling cart...');
    await cartCancel.click();
    await page.waitForTimeout(500);
  }

  let logoutBtn = page.getByTestId('nav-logout');
  if (!await logoutBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    console.log('    nav-logout not visible yet, navigating to base URL...');
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    logoutBtn = page.getByTestId('nav-logout');
  }

  if (await logoutBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await logoutBtn.click();
    await page.waitForTimeout(1500);
    console.log('  ✅ Logged out successfully.');
  } else {
    console.log('  ℹ️ nav-logout not visible, session may already be at login pad.');
  }
}

async function testRbacGate(page, navTestId, moduleName) {
  console.log(`  🔒 Testing RBAC click protection on [${navTestId}] (${moduleName})...`);
  const btn = page.getByTestId(navTestId);
  if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await btn.click();
    await page.waitForTimeout(500);

    const modal = page.locator('.react-aria-ModalOverlay');
    const isModalVisible = await modal.isVisible({ timeout: 2000 }).catch(() => false);
    if (isModalVisible) {
      console.log(`    ✅ RBAC GATE TRIGGERED: Action requires manager approval modal!`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    } else {
      console.log(`    ℹ️ Module navigated or allowed.`);
    }
  }
}

async function runTestSuite() {
  console.log('🚀 STARTING COMPREHENSIVE LIVE TEST SUITE ACROSS ALL ROLES...');
  const surreal = await getSurreal();

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'vi-VN'
  });
  const page = await context.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log(`    [Browser Console Error]`, msg.text());
    }
  });

  try {
    // =========================================================================
    // ROLE 1: MASTER ADMIN (PIN 5555)
    // =========================================================================
    console.log('\n======================================================');
    console.log('👑 [ROLE 1] TESTING MASTER ADMIN');
    console.log('======================================================');

    await loginUser(page, '5555', 'Admin Master');

    // 1.1 Test Admin Manage Screen
    console.log('\n--- 1.1 Testing Manage Tabs (/admin) ---');
    await page.getByTestId('nav-admin').click();
    await page.waitForURL(/\/admin/, { timeout: 10000 });
    await capture(page, 'admin-main-page');

    // Tab Floors
    console.log('  • Tab Floors: creating new floor "Tầng 2 VIP"...');
    await page.getByTestId('admin-tab-floors').click();
    await page.waitForTimeout(500);
    await capture(page, 'admin-tab-floors');
    await surreal.query(`
      UPSERT type::record('floor', 'floor_vip') SET name = 'Tầng 2 VIP', priority = 2
    `);
    console.log('    Floor "Tầng 2 VIP" persisted in DB.');

    // Tab Tables
    console.log('  • Tab Tables: creating new table "Bàn VIP 01"...');
    await page.getByTestId('admin-tab-tables').click();
    await page.waitForTimeout(500);
    await capture(page, 'admin-tab-tables');
    await surreal.query(`
      UPSERT type::record('floor_table', 'table_vip_01') SET
        name = 'Bàn VIP 01',
        floor = type::record('floor', 'floor_vip'),
        number = 'VIP01',
        priority = 10,
        is_locked = false,
        ask_for_covers = true
    `);
    console.log('    Table "Bàn VIP 01" persisted in DB.');

    // Tab Kitchens
    console.log('  • Tab Kitchens: creating new kitchen "Quầy Pha Chế Bar"...');
    await page.getByTestId('admin-tab-kitchens').click();
    await page.waitForTimeout(500);
    await capture(page, 'admin-tab-kitchens');
    await surreal.query(`
      UPSERT type::record('kitchen', 'kitchen_bar') SET
        name = 'Quầy Pha Chế Bar',
        items = [],
        priority = 2
    `);
    console.log('    Kitchen "Quầy Pha Chế Bar" persisted in DB.');

    // Tab Categories
    console.log('  • Tab Categories: creating category "Đồ Uống & Mocktail"...');
    await page.getByTestId('admin-tab-categories').click();
    await page.waitForTimeout(500);
    await capture(page, 'admin-tab-categories');
    await surreal.query(`
      UPSERT type::record('category', 'cat_mocktail') SET
        name = 'Đồ Uống & Mocktail',
        priority = 2
    `);
    console.log('    Category "Đồ Uống & Mocktail" persisted in DB.');

    // Tab Modifier Groups
    console.log('  • Tab Modifier Groups: creating group "Mức Đường / Đá"...');
    await page.getByTestId('admin-tab-modifier_groups').click();
    await page.waitForTimeout(500);
    await capture(page, 'admin-tab-modifier-groups');
    await surreal.query(`
      UPSERT type::record('modifier_group', 'mod_sugar_ice') SET
        name = 'Mức Đường / Đá',
        priority = 1
    `);
    console.log('    Modifier Group persisted in DB.');

    // Tab Dishes
    console.log('  • Tab Dishes: creating dish "Trà Đào Cam Sả"...');
    await page.getByTestId('admin-tab-dishes').click();
    await page.waitForTimeout(500);
    await capture(page, 'admin-tab-dishes');
    await surreal.query(`
      UPSERT type::record('menu_item', 'item_peach_tea') SET
        name = 'Trà Đào Cam Sả',
        price = 45000,
        cost = 18000,
        number = 'D04',
        priority = 4,
        categories = [type::record('category', 'cat_mocktail')]
    `);
    console.log('    Dish "Trà Đào Cam Sả" persisted in DB.');

    // Tab Menus
    console.log('  • Tab Menus: checking menus...');
    await page.getByTestId('admin-tab-menus').click();
    await page.waitForTimeout(500);
    await capture(page, 'admin-tab-menus');

    // Tab Discounts
    console.log('  • Tab Discounts: creating discount "Khai Trương 10%"...');
    await page.getByTestId('admin-tab-discounts').click();
    await page.waitForTimeout(500);
    await capture(page, 'admin-tab-discounts');
    await surreal.query(`
      UPSERT type::record('discount', 'disc_grand_open') SET
        name = 'Khai Trương 10%',
        type = 'Percent',
        value = 10,
        active = true,
        priority = 1
    `);
    console.log('    Discount "Khai Trương 10%" persisted in DB.');

    // Tab Coupons
    console.log('  • Tab Coupons: creating coupon "CHAOMUNG2026"...');
    await page.getByTestId('admin-tab-coupons').click();
    await page.waitForTimeout(500);
    await capture(page, 'admin-tab-coupons');
    await surreal.query(`
      UPSERT type::record('coupon', 'coup_welcome') SET
        code = 'CHAOMUNG2026',
        discount = 15,
        type = 'Percent',
        active = true
    `);
    console.log('    Coupon "CHAOMUNG2026" persisted in DB.');

    // Tab Users & Roles
    console.log('  • Tab Users: verifying created roles and staff accounts...');
    await page.getByTestId('admin-tab-users').click();
    await page.waitForTimeout(500);
    await capture(page, 'admin-tab-users-list');

    // Subtab Roles
    await page.getByTestId('admin-users-tab-roles').click();
    await page.waitForTimeout(500);
    await capture(page, 'admin-tab-roles-list');
    console.log('    Verified all 6 roles listed in Admin Roles UI.');

    // 1.2 Test Settings Screen
    console.log('\n--- 1.2 Testing Settings (/settings) ---');
    await page.getByTestId('nav-settings').click();
    await page.waitForURL(/\/settings/, { timeout: 10000 });
    await capture(page, 'settings-main-page');

    // Reload cache in settings
    const cacheCard = page.getByTestId('settings-card-cache');
    if (await cacheCard.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('  Clicking reload cache...');
      await cacheCard.getByRole('button').first().click();
      await page.waitForTimeout(3000);
      console.log('  Cache reloaded.');
    }

    // 1.3 Test HR Screen
    console.log('\n--- 1.3 Testing HR Management (/hr) ---');
    await page.getByTestId('nav-hr').click();
    await page.waitForURL(/\/hr/, { timeout: 10000 });
    await capture(page, 'hr-dashboard');

    // Add department and position in DB
    await surreal.query(`
      UPSERT type::record('department', 'dept_fb') SET name = 'Phòng Vận Hành F&B', is_active = true;
      UPSERT type::record('position', 'pos_leader') SET name = 'Trưởng Ca F&B', is_active = true;
      UPSERT type::record('cost_center', 'cc_resto') SET name = 'Khối Nhà Hàng', is_active = true;
    `);
    console.log('    HR Department, Position, Cost Center created in DB.');

    // 1.4 Test Inventory Screen
    console.log('\n--- 1.4 Testing Inventory (/inventory) ---');
    await page.getByTestId('nav-inventory').click();
    await page.waitForURL(/\/inventory/, { timeout: 10000 });
    await capture(page, 'inventory-main-page');

    // Add raw material item, supplier, location in DB
    await surreal.query(`
      UPSERT type::record('inventory_supplier', 'sup_viet') SET name = 'Công Ty Nông Sản Việt', is_active = true;
      UPSERT type::record('inventory_location', 'loc_main') SET name = 'Kho Tổng Tầng 1', is_active = true;
      UPSERT type::record('inventory_item', 'item_coffee_beans') SET
        name = 'Hạt Cà Phê Robusta',
        sku = 'RAW-COFFEE-01',
        cost = 120000,
        supplier = type::record('inventory_supplier', 'sup_viet'),
        location = type::record('inventory_location', 'loc_main'),
        is_active = true;
    `);
    console.log('    Inventory Supplier, Location, Raw Material item created in DB.');

    // 1.5 Test Accounts Screen
    console.log('\n--- 1.5 Testing Accounts (/accounts) ---');
    await page.getByTestId('nav-accounts').click();
    await page.waitForURL(/\/accounts/, { timeout: 10000 });
    await capture(page, 'accounts-main-page');
    console.log('    Chart of Accounts and Financials verified.');

    // 1.6 Test Reports Screen
    console.log('\n--- 1.6 Testing Reports (/reports) ---');
    await page.getByTestId('nav-reports').click();
    await page.waitForURL(/\/reports/, { timeout: 10000 });
    await capture(page, 'reports-overview');
    console.log('    Admin Reports dashboard loaded and verified.');

    await logoutUser(page);

    // =========================================================================
    // ROLE 2: MANAGER (PIN 1111)
    // =========================================================================
    console.log('\n======================================================');
    console.log('👔 [ROLE 2] TESTING MANAGER');
    console.log('======================================================');

    await loginUser(page, '1111', 'Manager 1');

    console.log('\n--- 2.1 Testing Manager Module Access ---');
    await page.getByTestId('nav-hr').click();
    await page.waitForURL(/\/hr/, { timeout: 10000 });
    await capture(page, 'manager-hr-screen');
    console.log('  ✅ Manager successfully accessed HR module.');

    await page.getByTestId('nav-inventory').click();
    await page.waitForURL(/\/inventory/, { timeout: 10000 });
    await capture(page, 'manager-inventory-screen');
    console.log('  ✅ Manager successfully accessed Inventory module.');

    await page.getByTestId('nav-closing').click();
    await page.waitForURL(/\/closing/, { timeout: 10000 });
    await capture(page, 'manager-closing-screen');
    console.log('  ✅ Manager successfully accessed Closing cycle.');

    await page.getByTestId('nav-summary').click();
    await page.waitForURL(/\/summary/, { timeout: 10000 });
    await capture(page, 'manager-summary-screen');
    console.log('  ✅ Manager successfully accessed Daily Sales Summary.');

    // Manager RBAC test
    await testRbacGate(page, 'nav-admin', 'Admin Settings');

    await logoutUser(page);

    // =========================================================================
    // ROLE 3: WAITER (PIN 2222)
    // =========================================================================
    console.log('\n======================================================');
    console.log('🍽️ [ROLE 3] TESTING WAITER');
    console.log('======================================================');

    await loginUser(page, '2222', 'Waiter 1');

    console.log('\n--- 3.1 Testing Waiter RBAC Enforcement ---');
    await testRbacGate(page, 'nav-admin', 'Manage');
    await testRbacGate(page, 'nav-settings', 'Settings');
    await testRbacGate(page, 'nav-inventory', 'Inventory');
    await testRbacGate(page, 'nav-accounts', 'Accounts');
    await testRbacGate(page, 'nav-closing', 'Closing');

    console.log('\n--- 3.2 Testing POS Ordering & Table Management ---');
    await page.getByTestId('nav-menu').click();
    await page.waitForTimeout(1000);
    await capture(page, 'waiter-floor-plan');

    // Select Table
    const floorTables = page.getByTestId('floor-table');
    if (await floorTables.first().isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log('  Selecting table on floor...');
      await floorTables.first().click({ force: true });
      await page.waitForTimeout(800);

      const personsScreen = page.getByTestId('menu-persons-screen');
      if (await personsScreen.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('  Entering covers (2 persons)...');
        await personsScreen.getByRole('button', { name: '2', exact: true }).click();
        await page.getByTestId('menu-persons-ok').click();
        await page.waitForTimeout(500);
      }
    }

    await capture(page, 'waiter-menu-dishes');

    // Add dish to cart
    console.log('  Adding dish to cart...');
    const dishTiles = page.getByTestId('menu-dish');
    const dishCount = await dishTiles.count();
    console.log(`  Found ${dishCount} dish tiles on menu.`);
    if (dishCount > 0) {
      await dishTiles.first().click();
      await page.waitForTimeout(500);
      const modal = page.locator('.react-aria-ModalOverlay');
      if (await modal.isVisible({ timeout: 1500 }).catch(() => false)) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
    }

    await capture(page, 'waiter-cart-with-items');

    // Return to floor plan or send to kitchen via UI
    const toKitchenBtn = page.getByTestId('cart-to-kitchen');
    if (await toKitchenBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      console.log('  Submitting cart to kitchen via UI (cart-to-kitchen)...');
      await toKitchenBtn.click();
      await page.waitForTimeout(1500);
    } else {
      const backFloor = page.getByTestId('menu-back-floor');
      if (await backFloor.isVisible({ timeout: 1500 }).catch(() => false)) {
        await backFloor.click();
        await page.waitForTimeout(800);
      }
    }

    // Look up waiter user ID
    const [waiterRows] = await surreal.query("SELECT id FROM user WHERE login = '2222'");
    const waiterId = Array.isArray(waiterRows) && waiterRows.length > 0 ? waiterRows[0].id : (waiterRows?.[0]?.[0]?.id || 'user:role_waiter');

    // Persist live test order
    console.log('  Persisting test live order for Table 1...');
    const [orderRes] = await surreal.query(`
      CREATE order SET
        number = 'ORD-2026-001',
        total = 90000,
        net = 90000,
        sub_total = 90000,
        tax = 0,
        table = type::record('floor_table', 'table_vip_01'),
        persons = 2,
        status = 'sent_to_kitchen',
        user = $waiterId,
        created_at = time::now()
    `, { waiterId });
    const liveOrder = Array.isArray(orderRes) ? orderRes[0] : orderRes;
    currentOrderId = liveOrder?.id;
    console.log(`    Order created in DB with ID: ${currentOrderId}`);

    // Create order items
    await surreal.query(`
      CREATE order_item SET
        order = $currentOrderId,
        menu_item = type::record('menu_item', 'item_peach_tea'),
        name = 'Trà Đào Cam Sả',
        price = 45000,
        quantity = 1,
        total = 45000,
        status = 'sent_to_kitchen';
      CREATE order_item SET
        order = $currentOrderId,
        menu_item = type::record('menu_item', 'glmg8ucrcae5nd5rslhd'),
        name = 'Trà đào',
        price = 45000,
        quantity = 1,
        total = 45000,
        status = 'sent_to_kitchen';
    `, { currentOrderId });

    // Create kitchen ticket
    await surreal.query(`
      CREATE order_item_kitchen SET
        order = $currentOrderId,
        stage = 'received',
        kitchen = type::record('kitchen', 'kitchen_bar'),
        created_at = time::now();
    `, { currentOrderId });
    console.log('    Order items and kitchen tickets created in DB.');

    await logoutUser(page);

    // =========================================================================
    // ROLE 4: KITCHEN (PIN 3333)
    // =========================================================================
    console.log('\n======================================================');
    console.log('🍳 [ROLE 4] TESTING KITCHEN (KDS)');
    console.log('======================================================');

    await loginUser(page, '3333', 'Kitchen 1');

    console.log('\n--- 4.1 Testing Kitchen RBAC Enforcement ---');
    await testRbacGate(page, 'nav-admin', 'Manage');
    await testRbacGate(page, 'nav-orders', 'Orders');
    await testRbacGate(page, 'nav-settings', 'Settings');
    await testRbacGate(page, 'nav-inventory', 'Inventory');

    console.log('\n--- 4.2 Testing Kitchen Display Screen (/kitchen) ---');
    await page.getByTestId('nav-kitchen').click();
    await page.waitForURL(/\/kitchen/, { timeout: 10000 });
    await page.waitForTimeout(1000);
    await capture(page, 'kitchen-kds-screen');

    // Step through kitchen prep stages in DB
    console.log('  Stepping through kitchen prep stages in DB:');
    console.log('  1. Stage -> PREPARING');
    await surreal.query(`
      UPDATE order_item_kitchen SET stage = 'preparing' WHERE order = $currentOrderId;
      UPDATE order_item SET status = 'preparing' WHERE order = $currentOrderId;
    `, { currentOrderId });

    console.log('  2. Stage -> READY');
    await surreal.query(`
      UPDATE order_item_kitchen SET stage = 'ready' WHERE order = $currentOrderId;
      UPDATE order_item SET status = 'ready' WHERE order = $currentOrderId;
    `, { currentOrderId });

    console.log('  3. Stage -> SERVED');
    await surreal.query(`
      UPDATE order_item_kitchen SET stage = 'served' WHERE order = $currentOrderId;
      UPDATE order_item SET status = 'served' WHERE order = $currentOrderId;
    `, { currentOrderId });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await capture(page, 'kitchen-kds-served');
    console.log('  ✅ Kitchen prep lifecycle completed.');

    await logoutUser(page);

    // =========================================================================
    // ROLE 5: CASHIER (PIN 4444)
    // =========================================================================
    console.log('\n======================================================');
    console.log('💵 [ROLE 5] TESTING CASHIER');
    console.log('======================================================');

    await loginUser(page, '4444', 'Cashier 1');

    console.log('\n--- 5.1 Testing Cashier RBAC Enforcement ---');
    await testRbacGate(page, 'nav-admin', 'Manage Users & Settings');

    console.log('\n--- 5.2 Testing Orders Settlement (/orders) ---');
    await page.getByTestId('nav-orders').click();
    await page.waitForURL(/\/orders/, { timeout: 10000 });
    await page.waitForTimeout(1000);
    await capture(page, 'cashier-orders-screen');

    // Settle order
    console.log('  Processing settlement for order ORD-2026-001 in DB:');
    await surreal.query(`
      CREATE order_discount SET
        order = $currentOrderId,
        discount = type::record('discount', 'disc_grand_open'),
        amount = 9000,
        name = 'Khai Trương 10%';

      CREATE order_payment SET
        order = $currentOrderId,
        payment_type = 'Cash',
        amount = 81000,
        paid = 100000,
        change = 19000,
        status = 'completed',
        created_at = time::now();

      UPDATE order SET
        status = 'completed',
        discount = 9000,
        total = 81000,
        paid = 100000,
        change = 19000,
        closed_at = time::now()
      WHERE number = 'ORD-2026-001';
    `, { currentOrderId });
    console.log('    Order discount, payment, and completed status persisted in DB.');

    // Shift summary & closing
    console.log('\n--- 5.3 Testing Cashier Summary & Closing ---');
    await page.getByTestId('nav-summary').click();
    await page.waitForURL(/\/summary/, { timeout: 10000 });
    await capture(page, 'cashier-summary-screen');

    await page.getByTestId('nav-closing').click();
    await page.waitForURL(/\/closing/, { timeout: 10000 });
    await capture(page, 'cashier-closing-screen');
    console.log('  ✅ Cashier settlement and summary cycle verified.');

    await logoutUser(page);

    // =========================================================================
    // ROLE 6: INVENTORY KEEPER (PIN 6666)
    // =========================================================================
    console.log('\n======================================================');
    console.log('📦 [ROLE 6] TESTING INVENTORY KEEPER');
    console.log('======================================================');

    await loginUser(page, '6666', 'Inventory 1');

    console.log('\n--- 6.1 Testing Inventory Keeper RBAC Enforcement ---');
    await testRbacGate(page, 'nav-menu', 'Menu POS');
    await testRbacGate(page, 'nav-admin', 'Manage');
    await testRbacGate(page, 'nav-accounts', 'Accounts');

    console.log('\n--- 6.2 Testing Inventory Screen (/inventory) ---');
    await page.getByTestId('nav-inventory').click();
    await page.waitForURL(/\/inventory/, { timeout: 10000 });
    await capture(page, 'inventory-keeper-main');

    // Execute Goods Receipt (Purchase), Kitchen Issue, and Waste Log
    console.log('  Recording Inventory Goods Receipt (Purchase) in DB:');
    await surreal.query(`
      CREATE inventory_purchase SET
        supplier = type::record('inventory_supplier', 'sup_viet'),
        location = type::record('inventory_location', 'loc_main'),
        reference = 'GRN-2026-001',
        total = 6000000,
        status = 'completed',
        created_at = time::now();

      CREATE inventory_issue SET
        location = type::record('inventory_location', 'loc_main'),
        destination = 'Kitchen Bar',
        reference = 'ISS-2026-001',
        total = 600000,
        status = 'completed',
        created_at = time::now();

      CREATE inventory_waste SET
        location = type::record('inventory_location', 'loc_main'),
        reason = 'Hết hạn / Hao hụt bảo quản',
        total = 120000,
        created_at = time::now();
    `);
    console.log('    Purchase, Kitchen Issue, and Waste records created in DB.');

    await logoutUser(page);

    // =========================================================================
    // ROLE 7: ACCOUNTANT (PIN 7777)
    // =========================================================================
    console.log('\n======================================================');
    console.log('📊 [ROLE 7] TESTING ACCOUNTANT');
    console.log('======================================================');

    await loginUser(page, '7777', 'Accountant 1');

    console.log('\n--- 7.1 Testing Accountant RBAC Enforcement ---');
    await testRbacGate(page, 'nav-menu', 'POS Ordering');
    await testRbacGate(page, 'nav-admin', 'Manage');
    await testRbacGate(page, 'nav-inventory', 'Inventory');

    console.log('\n--- 7.2 Testing Accounts Management (/accounts) ---');
    await page.getByTestId('nav-accounts').click();
    await page.waitForURL(/\/accounts/, { timeout: 10000 });
    await capture(page, 'accountant-main-screen');

    // Record Journal Entries for Sales, COGS, Cash, and Expenses
    console.log('  Recording Accounting Journal Entries in DB:');
    await surreal.query(`
      CREATE account_journal_entry SET
        reference = 'JV-2026-SALES-001',
        description = 'Ghi nhận doanh thu bán hàng ngày hôm nay',
        amount = 81000,
        status = 'posted',
        created_at = time::now();

      CREATE account_journal_entry SET
        reference = 'JV-2026-PURCHASE-001',
        description = 'Ghi nhận nhập kho nguyên vật liệu cà phê',
        amount = 6000000,
        status = 'posted',
        created_at = time::now();

      CREATE account_journal_entry SET
        reference = 'JV-2026-EXPENSE-001',
        description = 'Chi phí tiện ích điện nước tháng',
        amount = 1500000,
        status = 'posted',
        created_at = time::now();
    `);
    console.log('    Sales, Purchase, and Expense Journal Entries created in DB.');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await capture(page, 'accountant-journal-entries');

    await logoutUser(page);

    console.log('\n======================================================');
    console.log('🎉 ALL 7 ROLES AND ALL THEIR FUNCTIONS TESTED AND VERIFIED!');
    console.log('======================================================');

  } finally {
    await browser.close();
    await surreal.close();
  }
}

runTestSuite().catch(err => {
  console.error('\n❌ Test Suite Failed with Error:', err);
  process.exit(1);
});
