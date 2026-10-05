import { parsePhoneNumberFromString } from 'libphonenumber-js/min';

/** Phone numbers are stored in E.164 (+923001234567); Pakistan is the default country. */
export const DEFAULT_PHONE_COUNTRY = 'PK' as const;

/** "0300-1234567", "+92 300 1234567", "923001234567" -> "+923001234567"; null if invalid. */
export function normalizePhone(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const withPlus = /^92\d{10}$/.test(text.replace(/\D/g, '')) && !text.startsWith('0') ? `+${text.replace(/\D/g, '')}` : text;
  const parsed = parsePhoneNumberFromString(withPlus, DEFAULT_PHONE_COUNTRY);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}

/** "+923001234567" -> "0300 1234567" for Pakistani numbers; international format otherwise. */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return '';
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed) return e164;
  return parsed.country === DEFAULT_PHONE_COUNTRY ? parsed.formatNational() : parsed.formatInternational();
}

/** "+923001234567" -> "03001234567" (digits only, local form), used for search. */
export function localPhoneDigits(e164: string | null | undefined): string {
  if (!e164) return '';
  return e164.startsWith('+92') ? `0${e164.slice(3)}` : e164.replace(/\D/g, '');
}
