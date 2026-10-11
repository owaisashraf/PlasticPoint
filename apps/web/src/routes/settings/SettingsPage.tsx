import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { bpToPercentString, parsePercentToBp, type Settings, type SettingKey, type SettingsView } from '@shopledger/shared';
import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm, type UseFormReturn } from 'react-hook-form';
import { toast } from 'sonner';
import { FormField } from '@/components/FormField';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useCan } from '@/features/auth/useAuth';
import { api, ApiError, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { BackupsPanel } from './BackupsPanel';
import { ExpenseCategoriesPanel } from './ExpenseCategoriesPanel';
import { SECTIONS, type FieldDef } from './fields';
import { UsersPanel } from './UsersPanel';
import { WhatsAppPanel } from './WhatsAppPanel';

const SETTINGS_KEY = ['settings'] as const;

type FormValues = Record<string, string | boolean>;

const ALL_FIELDS = SECTIONS.flatMap((s) => s.fields);

function toForm(s: Settings): FormValues {
  const out: FormValues = {};
  for (const f of ALL_FIELDS) {
    const v = s[f.key];
    out[f.key] = f.kind === 'bool' ? Boolean(v) : f.kind === 'percent' ? bpToPercentString(v as number) : String(v);
  }
  return out;
}

/** Converts edited form values back to setting values; returns field errors for bad input. */
function fromForm(values: FormValues, keys: SettingKey[]): { changes: Partial<Settings>; errors: Record<string, string> } {
  const changes: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const key of keys) {
    const f = ALL_FIELDS.find((x) => x.key === key);
    if (!f) continue;
    const raw = values[key];
    if (f.kind === 'bool') changes[key] = Boolean(raw);
    else if (f.kind === 'percent') {
      const bp = parsePercentToBp(String(raw));
      if (bp === null || bp > 10_000) errors[key] = 'Enter a percentage like 12 or 12.5';
      else changes[key] = bp;
    } else if (f.kind === 'int' || (f.kind === 'select' && key === 'fiscal_year_start_month')) {
      const n = Number(String(raw).trim());
      if (!Number.isInteger(n)) errors[key] = 'Enter a whole number';
      else changes[key] = n;
    } else changes[key] = String(raw).trim();
  }
  return { changes: changes as Partial<Settings>, errors };
}

export function SettingsPage() {
  const can = useCan();
  const qc = useQueryClient();
  const [tab, setTab] = useState('business');
  const settings = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => api.get<SettingsView>('/api/settings') });

  const form = useForm<FormValues>({ defaultValues: {} });
  const { reset } = form;
  useEffect(() => {
    if (settings.data) reset(toForm(settings.data));
  }, [settings.data, reset]);

  const save = useMutation({
    mutationFn: (changes: Partial<Settings>) =>
      api.patch<{ settings: SettingsView; changed: SettingKey[]; restart_required: boolean }>('/api/settings', { changes }),
    onSuccess: (res) => {
      qc.setQueryData(SETTINGS_KEY, res.settings);
      void qc.invalidateQueries({ queryKey: ['settings', 'public'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      reset(toForm(res.settings));
      if (res.changed.length === 0) toast.info('Nothing changed.');
      else toast.success(res.restart_required ? 'Saved. Restart ShopLedger for the network change to take effect.' : 'Settings saved.');
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fields) {
        for (const [path, message] of Object.entries(e.fields)) form.setError(path.replace(/^changes\./, ''), { message });
      }
      toast.error(errorMessage(e));
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    const dirty = Object.keys(form.formState.dirtyFields) as SettingKey[];
    const { changes, errors } = fromForm(values, dirty);
    if (Object.keys(errors).length) {
      for (const [k, m] of Object.entries(errors)) form.setError(k, { message: m });
      toast.error('Please fix the highlighted fields.');
      return;
    }
    save.mutate(changes);
  });

  // Ctrl+S saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void onSubmit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSubmit]);

  const dirtyCount = Object.keys(form.formState.dirtyFields).length;
  const tabs = useMemo(
    () => [
      ...SECTIONS.map((s) => ({ id: s.id, title: s.title })),
      ...(can('expenses.manage') ? [{ id: 'expense_categories', title: 'Expense categories' }] : []),
      ...(can('users.manage_operators') ? [{ id: 'users', title: 'Users' }] : []),
    ],
    [can],
  );

  if (settings.isPending) return <p>Loading settings…</p>;
  if (settings.isError) return <p className="text-destructive">{errorMessage(settings.error)}</p>;

  const isSettingsTab = tab !== 'users' && tab !== 'expense_categories';
  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Settings"
        actions={
          isSettingsTab && (
            <>
              {dirtyCount > 0 && (
                <Button variant="outline" onClick={() => reset()}>
                  Undo changes
                </Button>
              )}
              <Button onClick={() => void onSubmit()} disabled={save.isPending || dirtyCount === 0} title="Ctrl+S">
                {save.isPending ? 'Saving…' : dirtyCount ? `Save ${dirtyCount} change${dirtyCount > 1 ? 's' : ''}` : 'Saved'}
              </Button>
            </>
          )
        }
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          {tabs.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              {t.title}
            </TabsTrigger>
          ))}
        </TabsList>
        {SECTIONS.map((s) => (
          <TabsContent key={s.id} value={s.id} forceMount hidden={tab !== s.id}>
            <Card>
              <CardHeader>
                <CardTitle>{s.title}</CardTitle>
                {s.description && <CardDescription>{s.description}</CardDescription>}
              </CardHeader>
              <CardContent>
                <form
                  className="grid grid-cols-1 gap-5 md:grid-cols-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void onSubmit();
                  }}
                >
                  {s.fields.map((f) => (
                    <SettingField key={f.key} field={f} form={form} />
                  ))}
                  <button type="submit" hidden />
                </form>
              </CardContent>
            </Card>
            {s.id === 'backups' && can('backups.manage') && <BackupsPanel />}
            {s.id === 'whatsapp' && settings.data && <WhatsAppPanel tokenSet={settings.data.secrets_set.whatsapp_cloud_token} />}
          </TabsContent>
        ))}
        {can('expenses.manage') && (
          <TabsContent value="expense_categories">
            <ExpenseCategoriesPanel />
          </TabsContent>
        )}
        {can('users.manage_operators') && (
          <TabsContent value="users">
            <UsersPanel />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

function SettingField({ field: f, form }: { field: FieldDef; form: UseFormReturn<FormValues> }) {
  const error = form.formState.errors[f.key]?.message;
  const dirty = Boolean(form.formState.dirtyFields[f.key]);
  const wide = (f.kind === 'text' && f.wide) || f.kind === 'textarea';
  const cls = cn(dirty && 'border-primary ring-1 ring-primary');

  return (
    <div className={cn(wide && 'md:col-span-2', f.kind === 'bool' && 'md:col-span-2')}>
      {f.kind === 'bool' ? (
        <div className="flex items-start gap-3">
          <Controller
            control={form.control}
            name={f.key}
            render={({ field }) => <Switch id={f.key} checked={Boolean(field.value)} onCheckedChange={field.onChange} />}
          />
          <div>
            <label htmlFor={f.key} className="cursor-pointer text-sm font-semibold">
              {f.label}
            </label>
            {f.hint && <p className="text-sm text-muted-foreground">{f.hint}</p>}
          </div>
        </div>
      ) : (
        <FormField label={f.label} htmlFor={f.key} error={error} hint={f.hint}>
          {f.kind === 'textarea' ? (
            <Textarea id={f.key} rows={8} className={cls} aria-invalid={Boolean(error)} {...form.register(f.key)} />
          ) : f.kind === 'select' ? (
            <NativeSelect id={f.key} className={cls} {...form.register(f.key)}>
              {f.options.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </NativeSelect>
          ) : (
            <div className="flex items-center gap-2">
              <Input
                id={f.key}
                className={cn(cls, (f.kind === 'int' || f.kind === 'percent' || f.kind === 'time') && 'w-28', f.kind !== 'text' && 'amount')}
                inputMode={f.kind === 'int' || f.kind === 'percent' ? 'decimal' : undefined}
                aria-invalid={Boolean(error)}
                {...form.register(f.key)}
              />
              {f.kind === 'percent' && <span className="text-muted-foreground">%</span>}
              {f.kind === 'int' && f.suffix && <span className="text-sm text-muted-foreground">{f.suffix}</span>}
            </div>
          )}
        </FormField>
      )}
    </div>
  );
}
