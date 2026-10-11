import { eq, inArray } from 'drizzle-orm';
import {
  DEFAULT_SETTINGS,
  PUBLIC_SETTING_KEYS,
  RESTART_SETTING_KEYS,
  SECRET_SETTING_KEYS,
  SETTING_KEYS,
  settingsSchema,
  validateSettings,
  type PublicSettings,
  type SettingKey,
  type Settings,
  type SettingsView,
} from '@shopledger/shared';
import { writeTx, type DB, type DbOrTx } from '../../db/client';
import { settings } from '../../db/schema';
import { writeAudit, type AuditActor } from '../../lib/audit';
import { nowIso } from '../../lib/dates';
import { badRequest } from '../../lib/errors';

/** All settings, with defaults filled in for anything not stored. */
export function getSettings(db: DbOrTx): Settings {
  const rows = db.select().from(settings).all();
  const stored: Record<string, unknown> = {};
  for (const r of rows) {
    if ((SETTING_KEYS as string[]).includes(r.key)) stored[r.key] = JSON.parse(r.value_json);
  }
  // A stored value that no longer validates (e.g. after a schema change) falls back to its default.
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const [k, v] of Object.entries(stored)) {
    const field = settingsSchema.shape[k as SettingKey];
    const parsed = field.safeParse(v);
    if (parsed.success) merged[k] = parsed.data;
  }
  return merged as Settings;
}

export function getSetting<K extends SettingKey>(db: DbOrTx, key: K): Settings[K] {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  if (!row) return DEFAULT_SETTINGS[key];
  const parsed = settingsSchema.shape[key].safeParse(JSON.parse(row.value_json));
  return (parsed.success ? parsed.data : DEFAULT_SETTINGS[key]) as Settings[K];
}

export function getPublicSettings(db: DbOrTx): PublicSettings {
  const all = getSettings(db);
  const out: Record<string, unknown> = {};
  for (const k of PUBLIC_SETTING_KEYS) out[k] = all[k];
  return out as PublicSettings;
}

/** Settings for the Settings screen: secrets (the WhatsApp token) are blanked, with a flag saying whether each is set. */
export function settingsView(s: Settings): SettingsView {
  const out = { ...s } as Record<string, unknown>;
  const secrets_set = {} as SettingsView['secrets_set'];
  for (const k of SECRET_SETTING_KEYS) {
    secrets_set[k] = Boolean(s[k]);
    out[k] = '';
  }
  return { ...(out as Settings), secrets_set };
}

/** A secret as the audit log records it: never the value itself. */
function auditValue(key: SettingKey, value: unknown): unknown {
  return (SECRET_SETTING_KEYS as readonly string[]).includes(key) ? (value ? '(hidden)' : '(none)') : value;
}

export interface UpdateSettingsResult {
  settings: SettingsView;
  changed: SettingKey[];
  restart_required: boolean;
}

/** Applies a partial update in one transaction with one audit row. */
export function updateSettings(db: DB, actor: AuditActor, changes: Partial<Settings>): UpdateSettingsResult {
  return writeTx(db, (tx) => {
    const before = getSettings(tx);
    const after: Settings = { ...before, ...changes };
    const errors = validateSettings(after);
    if (errors.length) throw badRequest(errors.join(' '));

    const changed = SETTING_KEYS.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    if (changed.length === 0) return { settings: settingsView(before), changed, restart_required: false };

    const now = nowIso();
    const toDefault = changed.filter((k) => JSON.stringify(after[k]) === JSON.stringify(DEFAULT_SETTINGS[k]));
    const toStore = changed.filter((k) => !toDefault.includes(k));
    if (toDefault.length) tx.delete(settings).where(inArray(settings.key, toDefault)).run();
    for (const k of toStore) {
      const value_json = JSON.stringify(after[k]);
      tx.insert(settings)
        .values({ key: k, value_json, updated_at: now, updated_by: actor.id })
        .onConflictDoUpdate({ target: settings.key, set: { value_json, updated_at: now, updated_by: actor.id } })
        .run();
    }

    const pick = (s: Settings) => Object.fromEntries(changed.map((k) => [k, auditValue(k, s[k])]));
    const priceKeys: SettingKey[] = [
      'default_supplier_margin_bp',
      'default_customer_discount_bp',
      'retail_discount_reduction_bp',
      'min_profit_bp',
      'below_min_profit_action',
    ];
    writeAudit(tx, actor, {
      action: 'update',
      entity: 'settings',
      before: pick(before),
      after: pick(after),
      summary: { changed_fields: changed },
      flags: changed.some((k) => priceKeys.includes(k)) ? ['price_changed'] : [],
    });

    return {
      settings: settingsView(after),
      changed,
      restart_required: changed.some((k) => RESTART_SETTING_KEYS.includes(k)),
    };
  });
}
