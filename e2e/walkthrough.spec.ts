import { expect, test, type Page } from '@playwright/test';

// A click-through of phases 1–7 on a fresh database, in order:
// first-run setup → owner sets up users, supplier, products → operator adds a
// customer, records a purchase, prints it and returns items → owner updates a
// price from a bill → operator sells (new customer, changed discount, cash,
// share) → a below-cost sale needs the owner password → owner sees profit →
// payments (FIFO), a return with refund, a bounced cheque and a write-off →
// an overdue customer (badges, Overdue tab, report) → owner edits an invoice →
// superuser reviews the diff in Change History and verifies the audit log.
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
  await expect(page.getByRole('listitem').filter({ hasText: 'Cracked on delivery' })).toContainText('PRN-000001');

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

test('7. operator sells to a new customer with a changed discount, takes cash and shares the invoice', async ({ page, context }) => {
  await login(page, 'ali', PW.operator);
  await page.keyboard.press('F4');
  await expect(page.getByRole('heading', { name: 'New sale', exact: true })).toBeVisible();

  // F2 → no match → add the customer inline; they are then selected.
  await page.keyboard.press('F2');
  await page.getByPlaceholder('Name, shop, phone, city or code…').fill('Bilal Traders');
  await page.getByRole('option', { name: /Add new customer/ }).click();
  const qd = page.getByRole('dialog');
  await expect(qd.getByText('Add new customer')).toBeVisible();
  await qd.getByLabel('Phone').fill('0321-7654321');
  await qd.getByLabel('City').fill('Multan');
  await qd.getByRole('button', { name: 'Add customer' }).click();
  await expect(page.getByLabel('Customer', { exact: true })).toContainText('Bilal Traders');
  await expect(page.getByLabel('Payment terms (days)')).toHaveValue('30');

  await page.getByLabel('Item code').fill('B-101');
  await page.getByLabel('Item code').press('Enter');
  await page.getByRole('dialog').getByLabel('Red 10L quantity').fill('3');
  await page.getByRole('dialog').getByLabel('Red 10L quantity').press('Control+Enter');

  // Price Rs 1,050 (fixed), 10% → Rs 2,835; changed to 12% → Rs 2,772.
  await expect(page.getByRole('cell', { name: 'Rs 2,835' })).toBeVisible();
  await page.getByLabel('Discount percent B-101 Red 10L').fill('12');
  await expect(page.getByRole('cell', { name: 'Rs 2,772' })).toBeVisible();
  // Operators never see profit.
  await expect(page.getByRole('columnheader', { name: 'Profit' })).toHaveCount(0);
  await page.getByLabel('Cash received now').fill('1000');
  await shot(page, '19-new-sale-operator');

  await page.keyboard.press('Control+Enter');
  const share = page.getByRole('dialog');
  await expect(share.getByText('Share invoice INV-000001')).toBeVisible();
  await shot(page, '20-share-dialog');
  const [popup, pdf] = await Promise.all([
    context.waitForEvent('page'),
    context.waitForEvent('response', (r) => r.url().includes('/api/sales/1/pdf')),
    share.getByRole('button', { name: 'Print / PDF (A4)' }).click(),
  ]);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  await popup.close();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: /Invoice INV-000001/ })).toBeVisible();
  await expect(page.getByText('RCV-000001')).toBeVisible();
  await expect(page.getByText('Rs 1,772').first()).toBeVisible();
  await shot(page, '21-sale-view-operator');
});

test('8. a below-cost discount needs the owner password', async ({ page }) => {
  await login(page, 'ali', PW.operator);
  await page.goto('/sales/new');
  await expect(page.getByRole('heading', { name: 'New sale', exact: true })).toBeVisible();
  await page.keyboard.press('F2');
  await page.getByPlaceholder('Name, shop, phone, city or code…').fill('Bilal');
  await page.getByRole('option', { name: /Bilal Traders/ }).click();
  await page.getByLabel('Item code').fill('B-101');
  await page.getByLabel('Item code').press('Enter');
  await page.getByRole('dialog').getByLabel('Blue 15L quantity').fill('1');
  await page.getByRole('dialog').getByLabel('Blue 15L quantity').press('Control+Enter');
  // 20% off Rs 1,050 = Rs 840, below the Rs 880 cost — the operator is not told why.
  await page.getByLabel('Discount percent B-101 Blue 15L').fill('20');
  await expect(page.getByText('This discount needs owner approval.')).toBeVisible();
  await expect(page.getByText(/cost|margin/i)).toHaveCount(0);
  await page.keyboard.press('Control+s');
  const ad = page.getByRole('dialog');
  await expect(ad.getByText('Owner approval needed')).toBeVisible();
  await ad.getByLabel('Owner username').fill('owner');
  await ad.getByLabel('Owner password').fill('wrong-password');
  await ad.getByRole('button', { name: 'Approve and save' }).click();
  await expect(ad.getByText('Wrong owner username or password.')).toBeVisible();
  await ad.getByLabel('Owner password').fill(PW.owner);
  await shot(page, '22-owner-approval');
  await ad.getByRole('button', { name: 'Approve and save' }).click();
  await expect(page.getByRole('heading', { name: /Invoice INV-000002/ })).toBeVisible();
  await expect(page.getByText(/approved by Shop Owner/)).toBeVisible();
});

test('9. owner sees profit on sales', async ({ page }) => {
  await login(page, 'owner', PW.owner);
  await nav(page, 'Sales').click();
  await expect(page.getByRole('columnheader', { name: 'Profit' })).toBeVisible();
  await shot(page, '23-sales-list-owner');
  await page.getByRole('cell', { name: 'INV-000002' }).click();
  await expect(page.getByRole('heading', { name: /Invoice INV-000002/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /B-101/ }).locator('.text-destructive')).toBeVisible();
  await shot(page, '24-sale-view-owner-loss');
  await logout(page);
});

test('10. operator receives a payment, applied oldest first', async ({ page }) => {
  await login(page, 'ali', PW.operator);
  await nav(page, 'Payments').click();
  await expect(page.getByRole('heading', { name: 'Payments', exact: true })).toBeVisible();
  await page.keyboard.press('F2');
  await page.getByPlaceholder('Name, shop, phone, city or code…').fill('Bilal');
  await page.getByRole('option', { name: /Bilal Traders/ }).click();
  const rd = page.getByRole('dialog');
  await expect(rd.getByText('Receive payment')).toBeVisible();
  await rd.getByLabel('Amount received').fill('2000');
  // INV-000001 has Rs 1,772 left, INV-000002 Rs 840: FIFO pays 1,772 then 228.
  await expect(rd.getByRole('row', { name: /INV-000001/ })).toContainText('Rs 1,772');
  await expect(rd.getByRole('row', { name: /INV-000002/ })).toContainText('Rs 228');
  await expect(rd.getByText('Kept as advance Rs 0')).toBeVisible();
  await shot(page, '25-receive-payment-fifo');
  await rd.getByRole('button', { name: /Save receipt/ }).click();
  await expect(page.getByText('Receipt RCV-000002 saved.')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'RCV-000002' })).toBeVisible();
  await shot(page, '26-payments-list');
});

test('11. operator takes a return from an invoice and pays part back', async ({ page }) => {
  await login(page, 'ali', PW.operator);
  await nav(page, 'Returns').click();
  await page.getByLabel('Return from invoice number').fill('INV-000002');
  await page.getByLabel('Return from invoice number').press('Enter');
  const rd = page.getByRole('dialog');
  await expect(rd.getByText('Return items from INV-000002')).toBeVisible();
  await rd.getByLabel(/Return quantity for B-101 Blue 15L/).fill('1');
  await rd.getByLabel('Reason').fill('Handle broken');
  await expect(rd.getByText('Credit Rs 840')).toBeVisible();
  // Rs 228 of the invoice was paid, so that much is paid back in cash.
  await rd.getByLabel('Pay money back now').check();
  await rd.getByLabel('Refund amount').fill('228');
  await shot(page, '27-sales-return-dialog');
  await rd.getByRole('button', { name: 'Save return' }).click();
  await expect(page.getByText('Return SRN-000001 saved: Rs 840 credited, Rs 228 paid back.')).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'Handle broken' })).toContainText('SRN-000001');
  await shot(page, '28-sale-after-return');

  await nav(page, 'Customers').click();
  await page.getByRole('cell', { name: 'Bilal Traders' }).click();
  await expect(page.getByRole('heading', { name: 'Bilal Traders', exact: true })).toBeVisible();
  await expect(page.getByText('Rs 0', { exact: true }).first()).toBeVisible();
  await page.getByRole('tab', { name: 'Ledger' }).click();
  await shot(page, '29-customer-ledger-after-return');
});

test('12. owner: a cheque bounces, then the debt is written off', async ({ page, context }) => {
  await login(page, 'owner', PW.owner);
  await nav(page, 'Customers').click();
  await page.getByRole('cell', { name: 'Ahmed Khan' }).click();
  await expect(page.getByRole('heading', { name: 'Ahmed Khan', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Record payment' }).click();
  const rd = page.getByRole('dialog');
  await rd.getByLabel('Amount received').fill('45000');
  await rd.getByLabel('Method').selectOption('cheque');
  await rd.getByLabel('Cheque no.').fill('112233');
  await rd.getByLabel('Bank', { exact: true }).fill('HBL');
  await expect(rd.getByRole('row', { name: /Opening balance/ })).toContainText('Rs 45,000');
  await rd.getByRole('button', { name: /Save receipt/ }).click();
  await expect(page.getByText('Receipt RCV-000003 saved.')).toBeVisible();

  await page.getByRole('tab', { name: 'Payments' }).click();
  await page.getByRole('cell', { name: /RCV-000003/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Mark cheque bounced' }).click();
  await page.getByRole('dialog').getByLabel('Reason').fill('Insufficient funds');
  await shot(page, '30-bounce-cheque');
  await page.getByRole('dialog').getByRole('button', { name: 'Mark bounced' }).click();
  await expect(page.getByText('Cheque marked as bounced.')).toBeVisible();
  await expect(page.getByRole('cell', { name: /RCV-000003 Bounced/ })).toBeVisible();

  await page.getByRole('button', { name: 'Write off' }).click();
  const wd = page.getByRole('dialog');
  await expect(wd.getByLabel('Amount')).toHaveValue('45000');
  await wd.getByLabel('Reason').fill('Shop closed, owner unreachable');
  await wd.getByRole('button', { name: 'Write off' }).click();
  await expect(page.getByText('Written off.')).toBeVisible();
  await expect(page.getByText('WOF-000001')).toBeVisible();
  await shot(page, '31-write-off');

  // Statement PDF opens in a new tab.
  await page.getByRole('tab', { name: 'Ledger' }).click();
  const [popup, pdf] = await Promise.all([
    context.waitForEvent('page'),
    context.waitForEvent('response', (r) => r.url().includes('/statement.pdf')),
    page.getByRole('button', { name: 'Statement PDF' }).click(),
  ]);
  expect(pdf.status()).toBe(200);
  await popup.close();
  await shot(page, '32-ledger-bounce-write-off');
  await logout(page);
});

test('13. a back-dated invoice makes a customer overdue: badges, the Overdue tab and its report', async ({ page, context }) => {
  // 60 days ago on 30-day terms → 30 days overdue (orange band).
  const sixtyDaysAgo = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date(Date.now() - 60 * 86_400_000));
  await login(page, 'ali', PW.operator);
  await expect(page.getByRole('navigation').getByLabel(/overdue customers/)).toHaveCount(0);
  await page.goto('/sales/new');
  await expect(page.getByRole('heading', { name: 'New sale', exact: true })).toBeVisible();
  await page.keyboard.press('F2');
  // A new customer with nothing paid. (With Bilal, his earlier receipt would
  // pay this older invoice first — FIFO — and nothing would be overdue.)
  await page.getByPlaceholder('Name, shop, phone, city or code…').fill('Danish Store');
  await page.getByRole('option', { name: /Add new customer/ }).click();
  await page.getByRole('dialog').getByLabel('City').fill('Karachi');
  await page.getByRole('dialog').getByRole('button', { name: 'Add customer' }).click();
  await expect(page.getByLabel('Customer', { exact: true })).toContainText('Danish Store');
  await page.getByLabel('Date', { exact: true }).fill(sixtyDaysAgo);
  await page.getByLabel('Item code').fill('B-101');
  await page.getByLabel('Item code').press('Enter');
  await page.getByRole('dialog').getByLabel('Red 10L quantity').fill('1');
  await page.getByRole('dialog').getByLabel('Red 10L quantity').press('Control+Enter');
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('heading', { name: /Invoice INV-000003/ })).toBeVisible();
  await expect(page.getByText('Overdue · 30 days')).toBeVisible();

  // Menu badge, then the Overdue tab.
  // The count is part of the menu link's name ("Overdue 1 overdue customers").
  await expect(page.getByRole('navigation').getByLabel('1 overdue customers')).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: /^Overdue/ }).click();
  const row = page.getByRole('row', { name: /Danish Store/ });
  await expect(row).toContainText('Rs 945');
  await expect(row).toContainText('30');
  await row.click();
  await expect(page.getByRole('link', { name: 'INV-000003' })).toBeVisible();
  await shot(page, '33-overdue-tab');

  const [popup, pdf] = await Promise.all([
    context.waitForEvent('page'),
    context.waitForEvent('response', (r) => r.url().includes('/api/overdue/report.pdf')),
    page.getByRole('button', { name: 'Print / PDF' }).click(),
  ]);
  expect(pdf.status()).toBe(200);
  await popup.close();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Export CSV' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^overdue-\d{4}-\d{2}-\d{2}\.csv$/);

  // The customer search on New Sale shows the overdue badge, and the sale warns.
  await page.goto('/sales/new');
  await expect(page.getByRole('heading', { name: 'New sale', exact: true })).toBeVisible();
  await page.keyboard.press('F2');
  await page.getByPlaceholder('Name, shop, phone, city or code…').fill('Danish');
  await expect(page.getByRole('option', { name: /Danish Store/ })).toContainText('Overdue Rs 945 · 30 days');
  await shot(page, '34-picker-overdue-badge');
  await page.getByRole('option', { name: /Danish Store/ }).click();
  await page.getByLabel('Item code').fill('B-101');
  await page.getByLabel('Item code').press('Enter');
  await page.getByRole('dialog').getByLabel('Red 10L quantity').fill('1');
  await page.getByRole('dialog').getByLabel('Red 10L quantity').press('Control+Enter');
  await expect(page.getByText('Danish Store has an overdue invoice: Rs 945, up to 30 days late.')).toBeVisible();
  await shot(page, '35-new-sale-overdue-warning');
});

test('14. an operator can edit their own invoice today but not void it; the owner edits an invoice', async ({ page }) => {
  await login(page, 'ali', PW.operator);
  await nav(page, 'Sales').click();
  await page.getByRole('cell', { name: 'INV-000001' }).click();
  await expect(page.getByRole('heading', { name: /Invoice INV-000001/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Void' })).toHaveCount(0);
  await logout(page);

  await login(page, 'owner', PW.owner);
  await nav(page, 'Sales').click();
  await page.getByRole('cell', { name: 'INV-000003' }).click();
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('heading', { name: 'Edit invoice INV-000003' })).toBeVisible();
  await expect(page.getByLabel('Quantity B-101 Red 10L')).toHaveValue('1');
  await page.getByLabel('Quantity B-101 Red 10L').fill('2');
  await page.getByLabel('Discount percent B-101 Red 10L').fill('12');
  await page.getByLabel('Reason for the change').fill('Customer took two, at the agreed 12%');
  await expect(page.getByRole('cell', { name: 'Rs 1,848' })).toBeVisible();
  await shot(page, '36-edit-invoice');
  await page.keyboard.press('Control+s');
  await expect(page.getByText('Invoice INV-000003 updated (version 2).')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Invoice INV-000003/ })).toBeVisible();
  await expect(page.getByText('Rs 1,848').first()).toBeVisible();
  await logout(page);
});

test('15. the superuser sees the edit and its diff in Change History, and reviews it', async ({ page }) => {
  await login(page, 'super', PW.super);
  await expect(page.getByLabel('Unreviewed flagged changes')).not.toHaveText('0');
  await nav(page, 'Change History').click();
  const row = page.getByRole('row', { name: /Edited.*INV-000003/ });
  await expect(row).toContainText('v1 → v2');
  await expect(row).toContainText('Total increased');
  await expect(row).toContainText('Customer took two');
  await shot(page, '37-change-history');
  await row.click();
  const d = page.getByRole('dialog');
  await expect(d.getByText(/B-101 Red 10L: Qty 1 → 2 · Discount % 10% → 12% · Line net Rs 945 → Rs 1,848/)).toBeVisible();
  await expect(d.getByText(/Timeline of INV-000003/)).toBeVisible();
  await shot(page, '38-change-diff');
  await d.getByLabel('Review note').fill('Confirmed with the owner');
  await d.getByRole('button', { name: 'Mark reviewed' }).click();
  await expect(d.getByText(/Reviewed by Main Admin/)).toBeVisible();
  await d.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(page.getByRole('row', { name: /Edited.*INV-000003/ }).getByLabel('Reviewed')).toBeVisible();
});

test('16. superuser verifies the audit log', async ({ page }) => {
  await login(page, 'super', PW.super);
  await nav(page, 'Change History').click();
  await page.getByRole('button', { name: 'Verify integrity' }).click();
  await expect(page.getByText('The audit log is intact')).toBeVisible();
  await shot(page, '18-verify-integrity');
});
