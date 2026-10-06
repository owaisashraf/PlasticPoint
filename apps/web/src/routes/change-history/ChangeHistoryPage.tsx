import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AUDIT_FLAGS,
  formatBp,
  formatPaisa,
  type AuditVerifyResult,
  type ChangeDetail,
  type ChangelogTab,
  type ChangeRow,
  type Customer,
  type DiscountOverrideRow,
  type PublicUser,
} from '@shopledger/shared';
import { Check, FileDown, FileText, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, NativeSelect } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CustomerPicker } from '@/features/customers/CustomerPicker';
import { api, errorMessage } from '@/lib/api';
import { cn, formatDateTime } from '@/lib/utils';

const CHANGELOG_KEY = ['changelog'] as const;

function qs(f: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== false) p.set(k, String(v));
  return p.toString();
}

// --- Labels ------------------------------------------------------------------------------

const ENTITY_LABEL: Record<string, string> = {
  sale: 'Invoice',
  purchase: 'Purchase',
  sales_return: 'Sales return',
  purchase_return: 'Purchase return',
  payment: 'Payment',
  write_off: 'Write-off',
  expense: 'Expense',
  asset: 'Asset',
  customer: 'Customer',
  product: 'Product',
  supplier: 'Supplier',
  user: 'User',
  settings: 'Settings',
  backup: 'Backup',
  session: 'Login',
};

const ACTION_LABEL: Record<string, string> = {
  create: 'Created',
  edit: 'Edited',
  update: 'Changed',
  void: 'Voided',
  print: 'Printed',
  share: 'Shared',
  bounce: 'Cheque bounced',
  reverse: 'Reversed',
  login: 'Logged in',
  logout: 'Logged out',
  login_failed: 'Login failed',
  approval_failed: 'Approval failed',
};

const FLAG_LABEL: Record<string, string> = {
  edited_after_shared: 'Edited after shared',
  edited_after_printed: 'Edited after printed',
  edited_later_day: 'Edited on a later day',
  total_reduced: 'Total reduced',
  total_increased: 'Total increased',
  customer_changed: 'Customer changed',
  discount_above_default: 'Discount above usual',
  profit_below_minimum: 'Profit below minimum',
  sold_below_cost: 'Sold below cost',
  extra_discount_added: 'Extra discount',
  price_changed: 'Price changed',
  voided: 'Voided',
  by_operator: 'By operator',
};

const FIELD_LABEL: Record<string, string> = {
  customer_id: 'Customer',
  supplier_id: 'Supplier',
  date: 'Date',
  due_date: 'Due date',
  payment_terms_days: 'Payment terms (days)',
  notes: 'Notes',
  status: 'Status',
  gross_paisa: 'Gross',
  line_discount_paisa: 'Line discounts',
  extra_discount_paisa: 'Extra discount',
  total_paisa: 'Total',
  total_cost_paisa: 'Total cost',
  amount_paisa: 'Amount',
  method: 'Method',
  reference: 'Reference',
  cheque_no: 'Cheque no.',
  reason: 'Reason',
  qty: 'Qty',
  list_price_paisa: 'Price',
  discount_bp: 'Discount %',
  default_discount_bp: 'Usual discount %',
  discount_overridden: 'Discount changed',
  supplier_margin_bp: 'Supplier margin %',
  line_net_paisa: 'Line net',
  line_cost_paisa: 'Line cost',
  profit_paisa: 'Profit',
  approved_by: 'Approved by (user id)',
};

/** Show a stored value the way the rest of the app does: money, percentages, yes/no. */
function show(field: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number' && field.endsWith('_paisa')) return formatPaisa(v);
  if (typeof v === 'number' && field.endsWith('_bp')) return formatBp(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

const label = (f: string) => FIELD_LABEL[f] ?? f.replace(/_paisa$|_bp$/, '').replaceAll('_', ' ');

function FlagChips({ flags }: { flags: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {flags.map((f) => (
        <span key={f} className={cn('rounded px-1.5 py-0.5 text-xs font-medium', f === 'by_operator' ? 'bg-slate-100 text-slate-700' : f === 'voided' || f === 'sold_below_cost' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-900')}>
          {FLAG_LABEL[f] ?? f}
        </span>
      ))}
    </div>
  );
}

function Money({ v, sign = false }: { v: number | null; sign?: boolean }) {
  if (v === null) return <span className="text-muted-foreground">—</span>;
  return <span className={cn('amount', sign && v < 0 && 'text-green-800', sign && v > 0 && 'text-red-800')}>{sign && v > 0 ? `+${formatPaisa(v)}` : formatPaisa(v)}</span>;
}

// --- Page ------------------------------------------------------------------------------------

/** Superuser only (CLAUDE.md 10.6): every change made to documents and records, from the audit log. */
export function ChangeHistoryPage() {
  const [params] = useSearchParams();
  const [tab, setTab] = useState<ChangelogTab | 'overrides'>('invoices');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState('');
  const [action, setAction] = useState('');
  const [flag, setFlag] = useState('');
  const [flaggedOnly, setFlaggedOnly] = useState(params.get('flagged') === '1');
  const [unreviewed, setUnreviewed] = useState(params.get('flagged') === '1');
  const [q, setQ] = useState('');
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [picking, setPicking] = useState(false);
  const [limit, setLimit] = useState(100);
  const [openId, setOpenId] = useState<number | null>(null);

  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<{ users: PublicUser[] }>('/api/users').then((r) => r.users) });
  const verify = useMutation({ mutationFn: () => api.get<AuditVerifyResult>('/api/audit/verify') });

  const filters = {
    tab: tab === 'overrides' ? 'invoices' : tab,
    from,
    to,
    user_id: userId,
    role,
    action,
    flag,
    flagged_only: flaggedOnly,
    unreviewed,
    q: q.trim(),
    customer_id: customer?.id,
  };
  const query = qs({ ...filters, limit });
  const list = useQuery({
    queryKey: [...CHANGELOG_KEY, 'list', query],
    queryFn: () => api.get<{ rows: ChangeRow[]; total: number }>(`/api/changelog?${query}`),
    enabled: tab !== 'overrides',
    placeholderData: (prev) => prev,
  });
  const rows = list.data?.rows ?? [];

  return (
    <div>
      <PageHeader
        title="Change History"
        description="Every document created, edited, voided, printed or shared, and every change to customers, products, users and settings."
        actions={
          <>
            {tab !== 'overrides' && (
              <Button variant="outline" asChild>
                <a href={`/api/changelog/export.csv?${qs(filters)}`} download>
                  <FileDown /> Export CSV
                </a>
              </Button>
            )}
            <Button onClick={() => verify.mutate()} disabled={verify.isPending}>
              <ShieldCheck /> {verify.isPending ? 'Checking…' : 'Verify integrity'}
            </Button>
          </>
        }
      />
      {verify.isError && <p className="font-medium text-destructive">{errorMessage(verify.error)}</p>}
      {verify.data && <VerifyCard r={verify.data} />}

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="invoices">Invoices</TabsTrigger>
          <TabsTrigger value="documents">All documents</TabsTrigger>
          <TabsTrigger value="other">Other changes</TabsTrigger>
          <TabsTrigger value="overrides">Discount overrides</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === 'overrides' ? (
        <DiscountOverrides />
      ) : (
        <>
          <div className="my-3 flex flex-wrap items-end gap-2">
            <label className="text-sm">
              From <Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="text-sm">
              To <Input type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
            <NativeSelect className="w-36" value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="User">
              <option value="">Any user</option>
              {(users.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.display_name}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect className="w-32" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
              <option value="">Any role</option>
              <option value="operator">Operator</option>
              <option value="owner">Owner</option>
              <option value="superuser">Superuser</option>
            </NativeSelect>
            <NativeSelect className="w-36" value={action} onChange={(e) => setAction(e.target.value)} aria-label="Action">
              <option value="">Any action</option>
              {Object.entries(ACTION_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect className="w-44" value={flag} onChange={(e) => setFlag(e.target.value)} aria-label="Flag">
              <option value="">Any flag</option>
              {AUDIT_FLAGS.map((f) => (
                <option key={f} value={f}>
                  {FLAG_LABEL[f]}
                </option>
              ))}
            </NativeSelect>
            <Button variant="outline" onClick={() => (customer ? setCustomer(null) : setPicking(true))}>
              {customer ? (
                <>
                  {customer.name} <X />
                </>
              ) : (
                'Any customer'
              )}
            </Button>
            <Input className="w-40" placeholder="Number or reason" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search number or reason" />
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={flaggedOnly} onChange={(e) => setFlaggedOnly(e.target.checked)} /> Flagged only
            </label>
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={unreviewed} onChange={(e) => setUnreviewed(e.target.checked)} /> Not yet reviewed
            </label>
          </div>

          {list.isError && <p className="text-destructive">{errorMessage(list.error)}</p>}
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">Who</th>
                  <th className="px-3 py-2">Action</th>
                  <th className="px-3 py-2">Document</th>
                  <th className="px-3 py-2">Customer / supplier</th>
                  <th className="px-3 py-2">Version</th>
                  <th className="px-3 py-2 text-right">Total before → after</th>
                  <th className="px-3 py-2 text-right">Balance impact</th>
                  <th className="px-3 py-2">Reason</th>
                  <th className="px-3 py-2">Flags</th>
                  <th className="px-3 py-2">Reviewed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    className="cursor-pointer border-t border-border align-top hover:bg-muted/60"
                    tabIndex={0}
                    onClick={() => setOpenId(r.id)}
                    onKeyDown={(e) => e.key === 'Enter' && setOpenId(r.id)}
                  >
                    <td className="px-3 py-2 whitespace-nowrap">{formatDateTime(r.at)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {r.user_name ?? '—'} <span className="text-muted-foreground">{r.user_role}</span>
                    </td>
                    <td className="px-3 py-2">{ACTION_LABEL[r.action] ?? r.action}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="text-muted-foreground">{ENTITY_LABEL[r.entity] ?? r.entity}</span> <span className="font-mono font-semibold">{r.doc_no}</span>
                    </td>
                    <td className="px-3 py-2">{r.party_name}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{r.version_after !== null ? `${r.version_before !== null && r.version_before !== r.version_after ? `v${r.version_before} → ` : ''}v${r.version_after}` : ''}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {r.total_before_paisa !== null || r.total_after_paisa !== null ? (
                        <>
                          <Money v={r.total_before_paisa} /> → <Money v={r.total_after_paisa} />
                        </>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right">{r.balance_impact_paisa !== null && r.balance_impact_paisa !== 0 ? <Money v={r.balance_impact_paisa} sign /> : null}</td>
                    <td className="max-w-56 px-3 py-2">{r.reason}</td>
                    <td className="px-3 py-2">
                      <FlagChips flags={r.flags} />
                    </td>
                    <td className="px-3 py-2">{r.review ? <Check className="size-4 text-green-700" aria-label="Reviewed" /> : null}</td>
                  </tr>
                ))}
                {list.data && rows.length === 0 && (
                  <tr>
                    <td colSpan={11} className="px-3 py-8 text-center text-muted-foreground">
                      Nothing matches these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {list.data && list.data.total > rows.length && (
            <Button className="mt-3" variant="outline" size="sm" onClick={() => setLimit((l) => l + 100)}>
              Show more ({rows.length} of {list.data.total})
            </Button>
          )}
        </>
      )}
      <CustomerPicker open={picking} onOpenChange={setPicking} onSelect={setCustomer} />
      {openId !== null && <ChangeDialog id={openId} onClose={() => setOpenId(null)} onOpen={setOpenId} />}
    </div>
  );
}

function VerifyCard({ r }: { r: AuditVerifyResult }) {
  return (
    <Card className={r.ok ? 'mb-4 max-w-2xl border-green-600' : 'mb-4 max-w-2xl border-destructive'}>
      <CardHeader>
        <CardTitle className={r.ok ? 'flex items-center gap-2 text-success' : 'flex items-center gap-2 text-destructive'}>
          {r.ok ? <ShieldCheck /> : <ShieldAlert />}
          {r.ok ? 'The audit log is intact' : 'The audit log has been tampered with'}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-[15px]">
        <p>{r.rows_checked} rows checked.</p>
        {r.last_hash && (
          <p className="break-all font-mono text-xs text-muted-foreground">
            Last row {r.last_id}: {r.last_hash}
          </p>
        )}
        {r.problems.length > 0 && (
          <ul className="list-disc pl-5 text-destructive">
            {r.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// --- One change: diff, timeline, review ------------------------------------------------------

function ChangeDialog({ id, onClose, onOpen }: { id: number; onClose: () => void; onOpen: (id: number) => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const change = useQuery({ queryKey: [...CHANGELOG_KEY, 'one', id], queryFn: () => api.get<{ change: ChangeDetail }>(`/api/changelog/${id}`).then((r) => r.change) });
  const c = change.data;
  const timeline = useQuery({
    queryKey: [...CHANGELOG_KEY, 'timeline', c?.entity, c?.entity_id],
    queryFn: () => api.get<{ rows: ChangeRow[] }>(`/api/changelog/timeline?entity=${c?.entity}&entity_id=${c?.entity_id}`).then((r) => r.rows),
    enabled: !!c?.entity_id && !!c.doc_no,
  });
  const review = useMutation({
    mutationFn: () => api.post(`/api/changelog/${id}/review`, { note }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CHANGELOG_KEY });
      toast.success('Marked as reviewed.');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const fields = c ? Object.entries(c.diff.fields) : [];
  const lines = c?.diff.lines;
  const summary = c?.summary ?? {};
  const profitBefore = typeof summary.profit_before_paisa === 'number' ? summary.profit_before_paisa : null;
  const profitAfter = typeof summary.profit_after_paisa === 'number' ? summary.profit_after_paisa : null;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {c ? `${ACTION_LABEL[c.action] ?? c.action}: ${ENTITY_LABEL[c.entity] ?? c.entity} ${c.doc_no ?? ''}` : 'Change'}
            {c && c.version_after !== null && <span className="ml-2 text-base font-normal text-muted-foreground">{c.version_before !== null ? `v${c.version_before} → ` : ''}v{c.version_after}</span>}
          </DialogTitle>
          {c && (
            <DialogDescription>
              {formatDateTime(c.at)} · {c.user_name ?? '—'} ({c.user_role}){c.party_name ? ` · ${c.party_name}` : ''}
              {c.reason ? ` · Reason: ${c.reason}` : ''}
            </DialogDescription>
          )}
        </DialogHeader>
        {change.isError && <p className="text-destructive">{errorMessage(change.error)}</p>}
        {c && (
          <div className="flex flex-col gap-4">
            <FlagChips flags={c.flags} />

            {(c.total_before_paisa !== null || c.total_after_paisa !== null) && (
              <div className="flex flex-wrap gap-6 rounded-md bg-muted px-4 py-2">
                <Stat k="Total">
                  <Money v={c.total_before_paisa} /> → <Money v={c.total_after_paisa} />
                </Stat>
                {c.balance_impact_paisa !== null && (
                  <Stat k="Balance impact">
                    <Money v={c.balance_impact_paisa} sign />
                  </Stat>
                )}
                {profitBefore !== null && profitAfter !== null && (
                  <Stat k="Profit">
                    <Money v={profitBefore} /> → <Money v={profitAfter} />
                  </Stat>
                )}
              </div>
            )}

            {fields.length > 0 && (
              <Section title="Header fields changed">
                <table className="w-full text-sm">
                  <thead className="text-left text-muted-foreground">
                    <tr>
                      <th className="py-1">Field</th>
                      <th>Before</th>
                      <th>After</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fields.map(([f, [a, b]]) => (
                      <tr key={f} className="border-t border-border">
                        <td className="py-1">{label(f)}</td>
                        <td className="text-red-800 line-through decoration-red-300">{show(f, a)}</td>
                        <td className="font-semibold text-green-800">{show(f, b)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Section>
            )}

            {lines && (lines.added.length > 0 || lines.removed.length > 0 || lines.changed.length > 0) && (
              <Section title="Lines">
                <ul className="flex flex-col gap-1 text-sm">
                  {lines.added.map((l, i) => (
                    <li key={`a${i}`} className="rounded bg-green-50 px-2 py-1 text-green-900">
                      + {lineText(l)}
                    </li>
                  ))}
                  {lines.removed.map((l, i) => (
                    <li key={`r${i}`} className="rounded bg-red-50 px-2 py-1 text-red-900 line-through decoration-red-300">
                      − {lineText(l)}
                    </li>
                  ))}
                  {lines.changed.map((l) => (
                    <li key={l.key} className="rounded bg-amber-50 px-2 py-1">
                      <span className="font-semibold">{l.label}</span>:{' '}
                      {LINE_FIELDS.filter((f) => f in l.fields)
                        .map((f) => `${label(f)} ${show(f, l.fields[f]?.[0])} → ${show(f, l.fields[f]?.[1])}`)
                        .join(' · ')}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {c.action === 'create' && Array.isArray(c.after?.lines) && (
              <Section title="Lines">
                <ul className="flex flex-col gap-1 text-sm">
                  {(c.after.lines as Record<string, unknown>[]).map((l, i) => (
                    <li key={i}>{lineText(l)}</li>
                  ))}
                </ul>
              </Section>
            )}

            {c.can_pdf && (
              <div className="flex gap-2">
                {c.before && (
                  <Button variant="outline" size="sm" onClick={() => window.open(`/api/changelog/${c.id}/pdf?which=before`, '_blank')}>
                    <FileText /> PDF before (v{String(c.before.version ?? '')})
                  </Button>
                )}
                {c.after && (
                  <Button variant="outline" size="sm" onClick={() => window.open(`/api/changelog/${c.id}/pdf?which=after`, '_blank')}>
                    <FileText /> PDF after (v{String(c.after.version ?? '')})
                  </Button>
                )}
              </div>
            )}

            {timeline.data && timeline.data.length > 1 && (
              <Section title={`Timeline of ${c.doc_no}`}>
                <ol className="flex flex-col gap-1 text-sm">
                  {timeline.data.map((t) => (
                    <li key={t.id} className={cn('flex flex-wrap items-center gap-2 rounded px-2 py-1', t.id === c.id && 'bg-blue-50')}>
                      <button type="button" className="cursor-pointer text-primary hover:underline" onClick={() => onOpen(t.id)}>
                        {formatDateTime(t.at)}
                      </button>
                      <span>{ACTION_LABEL[t.action] ?? t.action}</span>
                      {t.version_after !== null && <span className="text-muted-foreground">v{t.version_after}</span>}
                      <span className="text-muted-foreground">by {t.user_name ?? '—'}</span>
                      {t.total_after_paisa !== null && <Money v={t.total_after_paisa} />}
                      <FlagChips flags={t.flags.filter((f) => f !== 'by_operator')} />
                    </li>
                  ))}
                </ol>
              </Section>
            )}

            {c.entity === 'sale' && c.entity_id && (
              <Link to={`/sales/${c.entity_id}`} className="text-sm text-primary hover:underline" onClick={onClose}>
                Open the invoice as it is now →
              </Link>
            )}

            {c.review ? (
              <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-900">
                <Check className="mr-1 inline size-4" />
                Reviewed by {c.review.reviewed_by_name ?? '—'} on {formatDateTime(c.review.reviewed_at)}
                {c.review.note ? `: ${c.review.note}` : ''}
              </p>
            ) : null}
          </div>
        )}
        <DialogFooter className="items-center">
          {c && !c.review && (
            <>
              <Input className="mr-auto max-w-sm" placeholder="Review note (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Review note" />
              <Button onClick={() => review.mutate()} disabled={review.isPending}>
                <Check /> Mark reviewed
              </Button>
            </>
          )}
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Line fields shown in the diff, in this order (CLAUDE.md 10.6: qty, price, discount %; then the result). */
const LINE_FIELDS = ['qty', 'list_price_paisa', 'discount_bp', 'supplier_margin_bp', 'line_net_paisa', 'line_cost_paisa', 'profit_paisa'];

function lineText(l: Record<string, unknown>): string {
  const name = [l.item_code, l.color, l.size].filter(Boolean).join(' ');
  const parts = [
    typeof l.qty === 'number' ? `${l.qty} ×` : '',
    typeof l.list_price_paisa === 'number' ? formatPaisa(l.list_price_paisa) : '',
    typeof l.discount_bp === 'number' ? `− ${formatBp(l.discount_bp)}` : '',
    typeof l.line_net_paisa === 'number' ? `= ${formatPaisa(l.line_net_paisa)}` : typeof l.line_cost_paisa === 'number' ? `= ${formatPaisa(l.line_cost_paisa)}` : '',
    typeof l.amount_paisa === 'number' && !name ? formatPaisa(l.amount_paisa) : '',
  ].filter(Boolean);
  return `${name || (l.sale_doc_no as string | undefined) || ''} ${parts.join(' ')}`.trim();
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-sm font-semibold">{title}</div>
      {children}
    </div>
  );
}

function Stat({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="text-sm">
      <div className="text-muted-foreground">{k}</div>
      <div className="font-semibold">{children}</div>
    </div>
  );
}

// --- Discount overrides ------------------------------------------------------------------------

const REASON_LABEL: Record<string, string> = { discount_changed: 'Discount changed', below_min_profit: 'Below minimum profit', below_cost: 'Below cost' };

/** Sale lines with a changed discount, profit below the minimum, or sold below cost, grouped by who made the sale. */
function DiscountOverrides() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const data = useQuery({
    queryKey: [...CHANGELOG_KEY, 'overrides', from, to],
    queryFn: () => api.get<{ rows: DiscountOverrideRow[] }>(`/api/changelog/discount-overrides?${qs({ from, to })}`).then((r) => r.rows),
  });
  const rows = data.data ?? [];
  const byUser = new Map<string, DiscountOverrideRow[]>();
  for (const r of rows) byUser.set(r.user_name ?? '—', [...(byUser.get(r.user_name ?? '—') ?? []), r]);
  return (
    <div>
      <div className="my-3 flex flex-wrap items-end gap-2">
        <label className="text-sm">
          From <Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="text-sm">
          To <Input type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      {data.isError && <p className="text-destructive">{errorMessage(data.error)}</p>}
      {data.data && rows.length === 0 && <p className="text-muted-foreground">No changed discounts, low-profit or below-cost lines.</p>}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Invoice</th>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Customer</th>
              <th className="px-3 py-2">Item</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2 text-right">Usual → given</th>
              <th className="px-3 py-2 text-right">Line net</th>
              <th className="px-3 py-2 text-right">Profit</th>
              <th className="px-3 py-2">Why listed</th>
            </tr>
          </thead>
          <tbody>
            {[...byUser.entries()].map(([user, rs]) => (
              <Fragment key={user}>
                <tr className="border-t-2 border-border bg-muted/50">
                  <td colSpan={9} className="px-3 py-1.5 font-semibold">
                    {user} · {rs.length} line{rs.length === 1 ? '' : 's'}
                    {' · '}
                    {[...new Set(rs.map((r) => r.item_code))].length} product{[...new Set(rs.map((r) => r.item_code))].length === 1 ? '' : 's'}
                  </td>
                </tr>
                {rs.map((r, i) => (
                  <tr key={`${r.sale_id}-${i}`} className="border-t border-border">
                    <td className="px-3 py-1.5">
                      <Link to={`/sales/${r.sale_id}`} className="font-mono font-semibold text-primary hover:underline">
                        {r.doc_no}
                      </Link>
                    </td>
                    <td className="px-3 py-1.5">{r.date}</td>
                    <td className="px-3 py-1.5">{r.customer_name}</td>
                    <td className="px-3 py-1.5">
                      <span className="font-mono">{r.item_code}</span> {[r.color, r.size].filter(Boolean).join(' ')}
                    </td>
                    <td className="amount px-3 py-1.5">{r.qty}</td>
                    <td className="amount px-3 py-1.5">
                      {formatBp(r.default_discount_bp)} → <span className="font-semibold">{formatBp(r.discount_bp)}</span>
                    </td>
                    <td className="amount px-3 py-1.5">{formatPaisa(r.line_net_paisa)}</td>
                    <td className={cn('amount px-3 py-1.5', r.profit_paisa < 0 && 'font-semibold text-destructive')}>{formatPaisa(r.profit_paisa)}</td>
                    <td className="px-3 py-1.5">
                      {r.reasons.map((x) => (
                        <Badge key={x} variant={x === 'below_cost' ? 'danger' : x === 'below_min_profit' ? 'warning' : 'default'} className="mr-1">
                          {REASON_LABEL[x] ?? x}
                        </Badge>
                      ))}
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
