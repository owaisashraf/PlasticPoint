import { expect, test, type Page } from '@playwright/test';

// A click-through of phases 1–3 on a fresh database, in order:
// first-run setup → owner sets up users, supplier, products → operator adds a
// customer, records a purchase, prints it and returns items → owner updates a
// price from a bill → superuser verifies the audit log.
// Screenshots of each step go to test-results/walkthrough/.

test.describe.configure({ mode: 'serial' });

const PW = { super: 'super-pass-1', owner: 'owner-pass-1', operator: 'operator-pass-1' };

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `test-results/walkthrough/${name}.png`, fullPage: true });
}

async function login(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
}

async function logout(page: Page) {
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
}

function nav(page: Page, name: string) {
  return page.getByRole('navigation').getByRole('link', { name, exact: true });
}

test('1. first-run setup creates the superuser, then the owner', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByText('Step 1 of 2')).toBeVisible();
  await shot(page, '01-setup-superuser');
  await page.getByLabel('Full name').fill('Main Admin');
  await page.getByLabel('Username').fill('super');
  await page.getByLabel('Password', { exact: true }).fill(PW.super);
  await page.getByLabel('Type the password again').fill(PW.super);
  await page.getByRole('button', { name: 'Create superuser and continue' }).click();

  await expect(page.getByText('Step 2 of 2')).toBeVisible();
  await page.getByLabel('Full name').fill('Shop Owner');
  await page.getByLabel('Username').fill('owner');
  await page.getByLabel('Password', { exact: true }).fill(PW.owner);
  await page.getByLabel('Type the password again').fill(PW.owner);
  await page.getByRole('button', { name: 'Create owner and finish' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  // The superuser sees every menu, including Change History.
  await expect(nav(page, 'Change History')).toBeVisible();
  await shot(page, '02-superuser-dashboard');
  await logout(page);
});

test('2. owner adds an operator, the supplier and a product', async ({ page }) => {
  await login(page, 'owner', PW.owner);
  await expect(nav(page, 'Change History')).toHaveCount(0);

  // Settings → Users → add operator
  await nav(page, 'Settings').click();
  await page.getByRole('tab', { name: 'Users' }).click();
  await page.getByRole('button', { name: 'Add user' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Full name').fill('Ali Operator');
  await dialog.getByLabel('Username').fill('ali');
  await dialog.getByLabel('Password').fill(PW.operator);
  await dialog.getByRole('button', { name: 'Add user' }).click();
  await expect(page.getByRole('cell', { name: 'ali', exact: true })).toBeVisible();
  await shot(page, '03-settings-users');

  // Settings → Business name (Ctrl+S saves)
  await page.getByRole('tab', { name: 'Business' }).click();
  await page.getByLabel('Business name').fill('Plastic Point');
  await page.keyboard.press('Control+s');
  await expect(page.getByText('Settings saved.')).toBeVisible();

  // Purchases → Supplier tab
  await nav(page, 'Purchases').click();
  await page.getByRole('tab', { name: 'Supplier' }).click();
  await page.getByRole('button', { name: 'Add supplier' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Popular Plastics (Pvt) Ltd');
  await page.getByRole('dialog').getByLabel('Phone').fill('042-35761234');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Popular Plastics (Pvt) Ltd')).toBeVisible();

  // Products → new product with sizes and colors
  await nav(page, 'Products & Stock').click();
  await expect(page.getByRole('heading', { name: 'Products & Stock', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New product' }).click();
  const pd = page.getByRole('dialog');
  await pd.getByLabel('Item code').fill('b-101');
  await pd.getByLabel('Name').fill('Bucket with lid');
  await pd.getByLabel('Category').fill('Buckets');
  await pd.getByLabel('Sizes').fill('10L');
  await pd.getByLabel('Sizes').press('Enter');
  await pd.getByLabel('Sizes').fill('15L');
  await pd.getByLabel('Sizes').press('Enter');
  await pd.getByLabel('Colors').fill('Red, Blue,');
  await pd.getByLabel('Price').fill('1000');
  await expect(pd.getByText('4 variants')).toBeVisible();
  await shot(page, '04-new-product-form');
  await pd.getByRole('button', { name: 'Add product' }).click();

  await expect(page.getByRole('heading', { name: /B-101/ })).toBeVisible();
  // Owner sees the worked example: cost 880, profit 20 (2%).
  await expect(page.getByText('12% → Rs 880')).toBeVisible();
  await expect(page.getByText('Rs 20 (2%)')).toBeVisible();
  await shot(page, '05-product-owner-view');
  await logout(page);
});

test('3. operator adds a customer and finds it with F2', async ({ page }) => {
  await login(page, 'ali', PW.operator);
  // Operators do not see owner menus.
  for (const hidden of ['Settings', 'Expenses', 'Assets', 'Change History']) await expect(nav(page, hidden)).toHaveCount(0);

  await nav(page, 'Customers').click();
  await page.getByRole('button', { name: 'New customer' }).click();
  const cd = page.getByRole('dialog');
  await cd.getByLabel('Name', { exact: true }).fill('Ahmed Khan');
  await cd.getByLabel('Business name').fill('Khan Plastics');
  await cd.getByLabel('Phone', { exact: true }).fill('0300-1234567');
  await cd.getByLabel('City').fill('Lahore');
  await cd.getByLabel('Opening balance', { exact: true }).fill('45000');
  await cd.getByRole('button', { name: 'Add customer' }).click();
  await expect(page.getByRole('heading', { name: 'Ahmed Khan', exact: true })).toBeVisible();
  await expect(page.getByText('Rs 45,000').first()).toBeVisible();
  await page.getByRole('tab', { name: 'Ledger' }).click();
  await expect(page.getByRole('cell', { name: 'Opening balance' })).toBeVisible();
  await shot(page, '06-customer-ledger');

  await nav(page, 'Customers').click();
  await expect(page.getByRole('heading', { name: 'Customers', exact: true })).toBeVisible();
  await page.keyboard.press('F2');
  await page.getByPlaceholder('Name, shop, phone, city or code…').fill('0300 1234');
  await expect(page.getByRole('option', { name: /Ahmed Khan/ })).toBeVisible();
  await shot(page, '07-customer-picker');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Ahmed Khan', exact: true })).toBeVisible();
});

test('4. operator records a purchase with the size × color grid, prints it and returns items', async ({ page, context }) => {
  await login(page, 'ali', PW.operator);
  await nav(page, 'Purchases').click();
  await page.getByRole('button', { name: 'New purchase' }).click();
  await page.getByLabel("Supplier's bill no.").fill('PP-7781');

  await page.getByLabel('Item code').fill('b-101');
  await page.getByLabel('Item code').press('Enter');
  const grid = page.getByRole('dialog');
  await expect(grid.getByText('Bucket with lid')).toBeVisible();
  await grid.getByLabel('Red 10L quantity').fill('10');
  await grid.getByLabel('Red 10L quantity').press('Enter');
  await expect(grid.getByLabel('Red 15L quantity')).toBeFocused();
  await grid.getByLabel('Blue 15L quantity').fill('4');
  await shot(page, '08-size-color-grid');
  await grid.getByLabel('Blue 15L quantity').press('Control+Enter');

  // 10 × 1,000 at 12% → 8,800; 4 × 1,000 at 12% → 3,520; total 12,320
  await expect(page.getByRole('cell', { name: 'Rs 8,800' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Rs 12,320' })).toBeVisible();
  await shot(page, '09-new-purchase-lines');
  await page.keyboard.press('Control+s');

  await expect(page.getByRole('heading', { name: /Purchase PUR-000001/ })).toBeVisible();
  await expect(page.getByText('Rs 12,320')).toBeVisible();
  await shot(page, '10-purchase-view');

  // Print opens the PDF in a new tab. (Headless Chromium has no PDF viewer and
  // aborts the display, so check the tab received the PDF.)
  const [popup, pdf] = await Promise.all([
    context.waitForEvent('page'),
    context.waitForEvent('response', (r) => r.url().endsWith('/api/purchases/1/pdf')),
    page.getByRole('button', { name: 'Print / PDF' }).click(),
  ]);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  await popup.close();

  // Return 2 of the red 10L buckets.
  await page.getByRole('button', { name: 'Return items' }).click();
  const rd = page.getByRole('dialog');
  await rd.getByLabel(/Return quantity for B-101 Red 10L/).fill('2');
  await rd.getByLabel('Reason').fill('Cracked on delivery');
  await shot(page, '11-return-dialog');
  await rd.getByRole('button', { name: 'Save return' }).click();
  await expect(page.getByText('Return PRN-000001 saved.')).toBeVisible();
  await expect(page.getByText(/PRN-000001 · .* · Cracked on delivery/)).toBeVisible();

  // Stock grid on the product: Red 10L = 8, Blue 15L = 4.
  await nav(page, 'Products & Stock').click();
  await expect(page.getByRole('heading', { name: 'Products & Stock', exact: true })).toBeVisible();
  await page.getByRole('cell', { name: 'B-101', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Stock on hand', exact: true })).toBeVisible();
  await shot(page, '12-product-operator-view');
  await page.getByRole('button', { name: '8', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('PUR-000001')).toBeVisible();
  await expect(page.getByRole('dialog').getByText('PRN-000001')).toBeVisible();
  await shot(page, '13-stock-movements');
  await page.keyboard.press('Escape');
});

test('5. operator cannot see margins or change prices, and cannot open owner pages', async ({ page }) => {
  await login(page, 'ali', PW.operator);
  await nav(page, 'Products & Stock').click();
  await expect(page.getByRole('heading', { name: 'Products & Stock', exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Supplier margin' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Stock value' })).toHaveCount(0);
  await page.getByRole('cell', { name: 'B-101', exact: true }).click();
  await expect(page.getByText('Supplier margin → cost')).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('dialog').getByLabel('Price')).toBeDisabled();
  await expect(page.getByText('Only the owner can change the price.')).toBeVisible();
  await page.keyboard.press('Escape');

  for (const url of ['/settings', '/expenses', '/assets', '/change-history']) {
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Not available', exact: true })).toBeVisible();
  }
  await shot(page, '14-operator-not-available');
});

test('6. owner records a bill with a new price and updates the product', async ({ page }) => {
  await login(page, 'owner', PW.owner);
  await page.goto('/purchases/new');
  await page.getByLabel('Item code').fill('B-101');
  await page.getByLabel('Item code').press('Enter');
  await page.getByRole('dialog').getByLabel('Red 10L quantity').fill('5');
  await page.getByRole('dialog').getByLabel('Red 10L quantity').press('Control+Enter');
  await page.getByLabel('Price', { exact: true }).fill('1050');
  await page.keyboard.press('Control+s');

  const dlg = page.getByRole('dialog');
  await expect(dlg.getByText('The bill differs from the product')).toBeVisible();
  await expect(dlg.getByText('Rs 1,000 → Rs 1,050')).toBeVisible();
  await shot(page, '15-bill-differs-dialog');
  await dlg.getByRole('button', { name: 'Save and update 1 product' }).click();
  await expect(page.getByRole('heading', { name: /Purchase PUR-000002/ })).toBeVisible();

  await nav(page, 'Products & Stock').click();
  await expect(page.getByRole('heading', { name: 'Products & Stock', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Rs 1,050' })).toBeVisible();
  await page.getByRole('tab', { name: 'Stock value' }).click();
  await expect(page.getByRole('link', { name: 'B-101', exact: true })).toBeVisible();
  await shot(page, '16-stock-value');
  await page.getByRole('tab', { name: 'Products' }).click();
  await page.getByRole('cell', { name: 'B-101', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Price history', exact: true })).toBeVisible();
  await shot(page, '17-product-price-history');
  await logout(page);
});

test('7. superuser verifies the audit log', async ({ page }) => {
  await login(page, 'super', PW.super);
  await nav(page, 'Change History').click();
  await page.getByRole('button', { name: 'Verify integrity' }).click();
  await expect(page.getByText('The audit log is intact')).toBeVisible();
  await shot(page, '18-verify-integrity');
});
