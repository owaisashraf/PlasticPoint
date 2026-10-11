import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SendResult, SettingsView, WhatsAppLogEntry } from '@shopledger/shared';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { setupShop, type Shop } from '../../../test/shop';
import { updateSettings } from '../settings/service';

let t: TestContext;
let shop: Shop;
let opened: string[];

const SYSTEM = { id: null, role: 'system' };
const TOKEN = 'EAAG-secret-token-123';

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-10T06:00:00Z')); // business date 2026-10-10
  t = await createTestContext();
  opened = [];
  t.app.ctx.folderOpener = (file) => opened.push(file);
  // No test reaches the network: a send without a fake fails loudly.
  t.app.ctx.whatsappFetch = () => Promise.reject(new Error('network call in a test'));
  shop = await setupShop(t);
  updateSettings(t.dbh.db, SYSTEM, { business_name: 'Plastic Point' });
  await shop.ok('operator', 'PATCH', `/api/customers/${shop.customer.id}`, { phone: '0300-1234567' });
});
afterEach(async () => {
  vi.useRealTimers();
  await t.close();
});

const sendInvoice = (saleId: number, role: 'operator' | 'owner' = 'operator') => shop.call(role, 'POST', `/api/whatsapp/invoice/${saleId}`);
const logRows = () => t.dbh.sqlite.prepare('SELECT * FROM whatsapp_log ORDER BY id').all() as Record<string, unknown>[];
const shares = () => t.dbh.sqlite.prepare("SELECT * FROM audit_log WHERE action = 'share' ORDER BY id").all() as Record<string, unknown>[];

function useCloudApi() {
  updateSettings(t.dbh.db, SYSTEM, {
    whatsapp_cloud_phone_number_id: '1234567890',
    whatsapp_cloud_token: TOKEN,
    whatsapp_cloud_invoice_template: 'invoice_with_pdf',
    whatsapp_cloud_reminder_template: 'payment_reminder',
  });
  updateSettings(t.dbh.db, SYSTEM, { whatsapp_mode: 'cloud_api' });
}

/** A fake Graph API: records each call and answers from `replies` in order. */
function fakeGraph(replies: { status?: number; body: unknown }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  t.app.ctx.whatsappFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = replies.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

describe('click-to-chat (default mode)', () => {
  it('saves the invoice PDF, returns a wa.me link with the message, and logs and audits the share', async () => {
    const sale = await shop.sell({ qty: 2 }); // 2 × Rs 900, due 2026-10-31
    const before = t.auditCount();
    const res = await sendInvoice(sale.id);
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json<SendResult>();
    expect(r).toMatchObject({ mode: 'click_to_chat', status: 'opened', phone: '+923001234567', pdf_name: `${sale.doc_no}-v1.pdf` });
    expect(r.message).toContain(`Your invoice ${sale.doc_no} dated 01 Oct 2026 for Rs 1,800 is attached. Please pay by 31 Oct 2026.`);
    expect(r.message).toContain('Your total balance is Rs 1,800.');
    expect(r.message).toContain('Plastic Point');
    expect(r.url).toBe(`https://wa.me/923001234567?text=${encodeURIComponent(r.message)}`);
    expect(existsSync(join(t.config.invoicesDir, '2026', '10', `${sale.doc_no}-v1.pdf`))).toBe(true);

    expect(t.auditCount()).toBe(before + 1);
    expect(shares()[0]).toMatchObject({ entity: 'sale', entity_id: sale.id, doc_no: sale.doc_no, user_role: 'operator', version_before: 1, version_after: 1 });
    expect(logRows()).toEqual([
      expect.objectContaining({ kind: 'invoice', sale_id: sale.id, customer_id: shop.customer.id, mode: 'click_to_chat', status: 'opened', phone: '+923001234567', pdf_file: `invoices/2026/10/${sale.doc_no}-v1.pdf`, error: null }),
    ]);
  });

  it('the message never carries cost, margin or profit, even if the text asks for them', async () => {
    updateSettings(t.dbh.db, SYSTEM, { whatsapp_invoice_message: 'Total {amount}. Cost {cost} profit {profit} margin {supplier_margin}' });
    const sale = await shop.sell();
    const r = (await sendInvoice(sale.id)).json<SendResult>();
    expect(r.message).toBe('Total Rs 900. Cost {cost} profit {profit} margin {supplier_margin}');
    expect(r.message).not.toMatch(/880|20\b/);
  });

  it('an edit after sharing is flagged edited_after_shared', async () => {
    const sale = await shop.sell({ qty: 3 });
    await sendInvoice(sale.id);
    await shop.ok('owner', 'PUT', `/api/sales/${sale.id}`, { customer_id: shop.customer.id, date: '2026-10-01', lines: [{ variant_id: shop.variant(0), qty: 2, discount_bp: 1000 }], change_reason: 'Took fewer' });
    const edit = t.dbh.sqlite.prepare("SELECT flags FROM audit_log WHERE action = 'edit' AND entity = 'sale'").get() as { flags: string };
    expect(JSON.parse(edit.flags)).toContain('edited_after_shared');
    // The new version's PDF is what goes out next time.
    expect((await sendInvoice(sale.id)).json<SendResult>().pdf_name).toBe(`${sale.doc_no}-v2.pdf`);
  });

  it('a void invoice cannot be sent', async () => {
    const sale = await shop.sell();
    await shop.ok('owner', 'POST', `/api/sales/${sale.id}/void`, { reason: 'Entered twice' });
    const res = await sendInvoice(sale.id);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/void/);
  });

  it('a missing or invalid number gives a clear prompt, and the attempt is still logged', async () => {
    const sale = await shop.sell();
    t.dbh.sqlite.prepare('UPDATE customers SET phone = NULL WHERE id = ?').run(shop.customer.id);
    let res = await sendInvoice(sale.id);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'PHONE_MISSING', details: { customer_id: shop.customer.id } });
    expect(res.json().error).toBe('Ahmed Khan has no phone number. Add their WhatsApp number to send this.');

    t.dbh.sqlite.prepare("UPDATE customers SET phone = '12345' WHERE id = ?").run(shop.customer.id);
    res = await sendInvoice(sale.id);
    expect(res.json().code).toBe('PHONE_INVALID');
    expect(logRows().map((r) => [r.status, r.phone])).toEqual([
      ['failed', null],
      ['failed', '12345'],
    ]);
    expect(shares()).toHaveLength(0);
  });

  it('a statement is saved under DATA_DIR/statements and sent with the balance', async () => {
    await shop.sell({ qty: 2, date: '2026-09-01' });
    const r = await shop.ok<SendResult>('operator', 'POST', `/api/whatsapp/statement/${shop.customer.id}`, { from: '2026-09-01', to: '2026-10-10' });
    expect(r.pdf_name).toBe(`Statement-${shop.customer.code}-2026-10-10.pdf`);
    expect(r.message).toContain('Your balance is Rs 1,800.');
    const pdf = readFileSync(join(t.config.statementsDir, '2026', '10', r.pdf_name as string));
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(shares()[0]).toMatchObject({ entity: 'customer', entity_id: shop.customer.id, doc_no: shop.customer.code });
    expect(JSON.parse(shares()[0]?.summary_json as string)).toMatchObject({ kind: 'statement', from: '2026-09-01', to: '2026-10-10' });
  });

  it('a reminder states the overdue amount and days; with nothing overdue it is refused', async () => {
    const res = await shop.call('operator', 'POST', `/api/whatsapp/reminder/${shop.customer.id}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Nothing is overdue for Ahmed Khan.');

    await shop.sell({ date: '2026-08-01' }); // due 08-31 → 40 days overdue
    await shop.sell({ date: '2026-10-01' }); // not due yet
    const r = await shop.ok<SendResult>('operator', 'POST', `/api/whatsapp/reminder/${shop.customer.id}`);
    expect(r.message).toContain('Rs 900 on your account is overdue (up to 40 days). Your total balance is Rs 1,800.');
    expect(r.pdf_name).toBeNull();
    expect(logRows().at(-1)).toMatchObject({ kind: 'reminder', status: 'opened', pdf_file: null });
  });

  it('an advance reads "Advance Rs X" in messages', async () => {
    await shop.ok('operator', 'POST', '/api/payments/receipts', { customer_id: shop.customer.id, date: '2026-10-10', amount_paisa: 50_000, method: 'cash' });
    const r = await shop.ok<SendResult>('operator', 'POST', `/api/whatsapp/statement/${shop.customer.id}`, {});
    expect(r.message).toContain('Your balance is Advance Rs 500.');
  });

  it('history shows when an invoice was sent and by whom', async () => {
    const sale = await shop.sell();
    await sendInvoice(sale.id);
    const { entries } = await shop.ok<{ entries: WhatsAppLogEntry[] }>('operator', 'GET', `/api/whatsapp/history?sale_id=${sale.id}`);
    expect(entries).toEqual([expect.objectContaining({ kind: 'invoice', status: 'opened', user_name: 'operator', doc_no: sale.doc_no, pdf_name: `${sale.doc_no}-v1.pdf`, at: '2026-10-10T06:00:00.000Z' })]);
    const byCustomer = await shop.ok<{ entries: WhatsAppLogEntry[] }>('operator', 'GET', `/api/whatsapp/history?customer_id=${shop.customer.id}`);
    expect(byCustomer.entries).toHaveLength(1);
  });
});

describe('open folder', () => {
  it('opens Explorer at the saved PDF, only from the laptop itself', async () => {
    const sale = await shop.sell();
    const { log_id } = (await sendInvoice(sale.id)).json<SendResult>();
    const res = await shop.call('operator', 'POST', `/api/whatsapp/log/${log_id}/open-folder`);
    expect(res.statusCode, res.body).toBe(200);
    expect(opened).toEqual([join(t.config.invoicesDir, '2026', '10', `${sale.doc_no}-v1.pdf`)]);

    const remote = await t.app.inject({ method: 'POST', url: `/api/whatsapp/log/${log_id}/open-folder`, headers: { cookie: await t.cookie('operator') }, remoteAddress: '192.168.1.20' });
    expect(remote.statusCode).toBe(403);
    expect(remote.json().error).toMatch(/shop laptop/);
    expect(opened).toHaveLength(1);
  });

  it('a reminder has no file to show', async () => {
    await shop.sell({ date: '2026-08-01' });
    const { log_id } = await shop.ok<SendResult>('operator', 'POST', `/api/whatsapp/reminder/${shop.customer.id}`);
    expect((await shop.call('operator', 'POST', `/api/whatsapp/log/${log_id}/open-folder`)).statusCode).toBe(400);
  });
});

describe('Cloud API mode', () => {
  it('uploads the PDF, sends the template with the document header and body parameters, and logs the message id', async () => {
    useCloudApi();
    const sale = await shop.sell({ qty: 2 });
    const calls = fakeGraph([{ body: { id: 'media-1' } }, { body: { messages: [{ id: 'wamid.ABC' }] } }]);
    const r = (await sendInvoice(sale.id)).json<SendResult>();
    expect(r).toMatchObject({ mode: 'cloud_api', status: 'sent', url: null, phone: '+923001234567' });

    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ['POST', 'https://graph.facebook.com/v23.0/1234567890/media'],
      ['POST', 'https://graph.facebook.com/v23.0/1234567890/messages'],
    ]);
    for (const c of calls) expect((c.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    const upload = c0(calls).init.body as FormData;
    expect(upload.get('messaging_product')).toBe('whatsapp');
    expect((upload.get('file') as File).name).toBe(`${sale.doc_no}.pdf`);
    expect(JSON.parse(calls[1]?.init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      to: '923001234567',
      type: 'template',
      template: {
        name: 'invoice_with_pdf',
        language: { code: 'en' },
        components: [
          { type: 'header', parameters: [{ type: 'document', document: { id: 'media-1', filename: `${sale.doc_no}.pdf` } }] },
          {
            type: 'body',
            parameters: ['Ahmed Khan', sale.doc_no, 'Rs 1,800', '31 Oct 2026'].map((text) => ({ type: 'text', text })),
          },
        ],
      },
    });
    expect(logRows()).toEqual([expect.objectContaining({ mode: 'cloud_api', status: 'sent', message_id: 'wamid.ABC' })]);
    expect(shares()).toHaveLength(1);
  });

  it('a reminder is a template without a document', async () => {
    useCloudApi();
    await shop.sell({ date: '2026-08-01' });
    const calls = fakeGraph([{ body: { messages: [{ id: 'wamid.R' }] } }]);
    await shop.ok('operator', 'POST', `/api/whatsapp/reminder/${shop.customer.id}`);
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body.template.name).toBe('payment_reminder');
    expect(body.template.components).toEqual([{ type: 'body', parameters: ['Ahmed Khan', 'Rs 900', '40', 'Rs 900'].map((text) => ({ type: 'text', text })) }]);
  });

  it('a refused message is logged as failed with a plain error, no share is audited, and the token never appears', async () => {
    useCloudApi();
    const sale = await shop.sell();
    fakeGraph([{ body: { id: 'media-1' } }, { status: 400, body: { error: { message: `Invalid parameter ${TOKEN}`, code: 131009, error_data: { details: 'Recipient phone number not in allowed list' } } } }]);
    const res = await sendInvoice(sale.id);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: 'WHATSAPP_FAILED', error: 'WhatsApp did not accept it: Recipient phone number not in allowed list (code 131009)' });
    expect(logRows()).toEqual([expect.objectContaining({ status: 'failed', error: 'WhatsApp did not accept it: Recipient phone number not in allowed list (code 131009)' })]);
    expect(shares()).toHaveLength(0);

    t.app.ctx.whatsappFetch = () => Promise.reject(new TypeError('fetch failed'));
    expect((await sendInvoice(sale.id)).json().error).toBe('Could not reach WhatsApp. Check the internet connection and try again.');

    const everything = JSON.stringify([logRows(), t.dbh.sqlite.prepare('SELECT * FROM audit_log').all()]);
    expect(everything).not.toContain(TOKEN);
  });

  it('a kind without a template name is refused with a pointer to settings', async () => {
    useCloudApi();
    fakeGraph([]);
    const res = await shop.call('operator', 'POST', `/api/whatsapp/statement/${shop.customer.id}`, {});
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('No WhatsApp template name is set for statements. Add it in Settings → WhatsApp.');
  });

  it('Test connection checks the saved details (owner only)', async () => {
    useCloudApi();
    const calls = fakeGraph([{ body: { display_phone_number: '+92 300 1112223', verified_name: 'Plastic Point' } }]);
    expect(await shop.ok('owner', 'POST', '/api/whatsapp/test')).toEqual({ ok: true, display_phone_number: '+92 300 1112223', verified_name: 'Plastic Point' });
    expect(calls[0]?.url).toBe('https://graph.facebook.com/v23.0/1234567890?fields=display_phone_number,verified_name');
    expect((await shop.call('operator', 'POST', '/api/whatsapp/test')).statusCode).toBe(403);
  });
});

describe('WhatsApp settings', () => {
  it('the access token is never sent to the browser or written to the audit log', async () => {
    const res = await shop.ok<{ settings: SettingsView }>('owner', 'PATCH', '/api/settings', { changes: { whatsapp_cloud_token: TOKEN } });
    expect(res.settings.whatsapp_cloud_token).toBe('');
    expect(res.settings.secrets_set.whatsapp_cloud_token).toBe(true);
    const view = await shop.ok<SettingsView>('owner', 'GET', '/api/settings');
    expect(view.whatsapp_cloud_token).toBe('');
    expect(view.secrets_set).toEqual({ whatsapp_cloud_token: true });
    const row = t.dbh.sqlite.prepare("SELECT before_json, after_json FROM audit_log WHERE entity = 'settings' ORDER BY id DESC").get() as Record<string, string>;
    expect(JSON.parse(row.after_json as string)).toEqual({ whatsapp_cloud_token: '(hidden)' });
    expect(JSON.parse(row.before_json as string)).toEqual({ whatsapp_cloud_token: '(none)' });
  });

  it('Cloud API mode needs the phone number ID, token and invoice template first', async () => {
    const res = await shop.call('owner', 'PATCH', '/api/settings', { changes: { whatsapp_mode: 'cloud_api' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/phone number ID, the access token and the invoice template/);
  });

  it('template parameters must be known placeholder names', async () => {
    const res = await shop.call('owner', 'PATCH', '/api/settings', { changes: { whatsapp_cloud_invoice_params: 'customer_name,profit' } });
    expect(res.statusCode).toBe(400);
  });

  it('operators see the mode (to open the WhatsApp tab) but not the WhatsApp settings', async () => {
    const pub = await shop.ok<Record<string, unknown>>('operator', 'GET', '/api/settings/public');
    expect(pub.whatsapp_mode).toBe('click_to_chat');
    expect(Object.keys(pub).filter((k) => k.startsWith('whatsapp_') && k !== 'whatsapp_mode')).toEqual([]);
  });
});

function c0<T>(a: T[]): T {
  const x = a[0];
  if (!x) throw new Error('no call');
  return x;
}
