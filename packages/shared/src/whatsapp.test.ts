import { describe, expect, it } from 'vitest';
import { settingsPatchSchema } from './settings';
import { balanceForCustomer, DEFAULT_WHATSAPP_MESSAGES, parseWhatsAppParams, renderWhatsAppMessage, unknownPlaceholders, waMeUrl } from './whatsapp';

describe('WhatsApp messages', () => {
  it('fills the placeholders and leaves unknown ones as typed', () => {
    expect(renderWhatsAppMessage('Dear {customer_name}, {invoice_no} for {amount}. {profit}', { customer_name: 'Ahmed', invoice_no: 'INV-000001', amount: 'Rs 900' })).toBe(
      'Dear Ahmed, INV-000001 for Rs 900. {profit}',
    );
    expect(unknownPlaceholders('{amount} {cost} {cost} {profit}')).toEqual(['cost', 'profit']);
  });

  it('the default messages use only known placeholders', () => {
    for (const m of Object.values(DEFAULT_WHATSAPP_MESSAGES)) expect(unknownPlaceholders(m)).toEqual([]);
  });

  it('template values are a comma list of known placeholders', () => {
    expect(parseWhatsAppParams('customer_name, {amount},due_date')).toEqual(['customer_name', 'amount', 'due_date']);
    expect(parseWhatsAppParams('')).toEqual([]);
    expect(parseWhatsAppParams('customer_name,profit')).toBeNull();
  });

  it('wa.me links use the number without + and an encoded message', () => {
    expect(waMeUrl('+923001234567', 'Hello Ahmed & co\nRs 1,000')).toBe('https://wa.me/923001234567?text=Hello%20Ahmed%20%26%20co%0ARs%201%2C000');
  });

  it('balances read as customers expect', () => {
    expect(balanceForCustomer(123_400)).toBe('Rs 1,234');
    expect(balanceForCustomer(-50_000)).toBe('Advance Rs 500');
    expect(balanceForCustomer(0)).toBe('Rs 0');
  });
});

describe('settings patch', () => {
  it('keeps only the keys sent (no defaults filled in)', () => {
    expect(settingsPatchSchema.parse({ changes: { grace_days: 3 } })).toEqual({ changes: { grace_days: 3 } });
    expect(settingsPatchSchema.safeParse({ changes: { grace_days: -1 } }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ changes: { unknown_key: 1 } }).success).toBe(false);
  });
});
