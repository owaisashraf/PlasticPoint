import { useQuery } from '@tanstack/react-query';
import {
  bpToPercentString,
  fiscalYearStartOf,
  formatPaisa,
  type Customer,
  type ReportCell,
  type ReportDef,
  type ReportKind,
  type ReportResult,
  type ReportRow,
} from '@shopledger/shared';
import { FileDown, Printer, X } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input, NativeSelect } from '@/components/ui/input';
import { useCities, usePublicSettings } from '@/features/customers/api';
import { CustomerPicker } from '@/features/customers/CustomerPicker';
import { useExpenseCategories } from '@/features/expenses/api';
import { api, errorMessage } from '@/lib/api';
import { cn, todayKarachi } from '@/lib/utils';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDate(d: string): string {
  const [y, m, day] = d.split('-');
  return `${day} ${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

/** A cell the way the app shows numbers everywhere: Rs, %, days. */
function cellText(v: ReportCell | undefined, kind: ReportKind): string {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') {
    if (kind === 'money') return formatPaisa(v);
    if (kind === 'percent') return `${bpToPercentString(v)}%`;
    if (kind === 'days') return `${v} d`;
    return String(v);
  }
  if (kind === 'date') return fmtDate(v);
  return v;
}

const numeric = (k: ReportKind) => k === 'money' || k === 'int' || k === 'percent' || k === 'days';

function qs(f: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== false) p.set(k, String(v));
  return p.toString();
}

function monthStart(d: string): string {
  return `${d.slice(0, 7)}-01`;
}

/**
 * Any report (CLAUDE.md 11): its filters, key figures and table, with print
 * (PDF in a new tab) and CSV export. `fixed` pins parameters, e.g. one
 * customer on the customer page.
 */
export function ReportView({ def, fixed = {}, compact = false }: { def: ReportDef; fixed?: Record<string, string | number>; compact?: boolean }) {
  const navigate = useNavigate();
  const settings = usePublicSettings().data;
  const startMonth = settings?.fiscal_year_start_month ?? 7;
  const today = todayKarachi();
  const has = (p: string) => def.params.includes(p as never);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [asOf, setAsOf] = useState('');
  const [party, setParty] = useState('all');
  const [type, setType] = useState('');
  const [city, setCity] = useState('');
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [picking, setPicking] = useState(false);
  const [groupBy, setGroupBy] = useState(def.groupBy?.[0]?.value ?? '');
  const [show, setShow] = useState(def.show?.[0]?.value ?? '');
  const [category, setCategory] = useState('');
  const [expenseCategory, setExpenseCategory] = useState('');
  const [method, setMethod] = useState('');
  const [inactiveDays, setInactiveDays] = useState('60');
  const [fy, setFy] = useState('');
  const [calendar, setCalendar] = useState(false);
  const [compare, setCompare] = useState(false);

  const cities = useCities(has('city'));
  const categories = useQuery({ queryKey: ['products', 'categories'], queryFn: () => api.get<{ categories: string[] }>('/api/products/categories').then((r) => r.categories), enabled: has('category') });
  const expenseCats = useExpenseCategories(has('expense_category'));

  const params = {
    from: has('period') ? from : undefined,
    to: has('period') ? to : undefined,
    as_of: has('as_of') ? asOf : undefined,
    party: has('party') ? party : undefined,
    type: has('type') ? type : undefined,
    city: has('city') ? city : undefined,
    customer_id: has('customer') ? customer?.id : undefined,
    group_by: def.groupBy ? groupBy : undefined,
    show: def.show ? show : undefined,
    category: has('category') ? category : undefined,
    expense_category_id: has('expense_category') ? expenseCategory : undefined,
    method: has('method') ? method : undefined,
    inactive_days: has('inactive_days') ? inactiveDays : undefined,
    fiscal_year: has('fiscal_year') ? fy : undefined,
    calendar: has('fiscal_year') ? calendar : undefined,
    compare: has('compare') ? compare : undefined,
    ...fixed,
  };
  const query = qs(params);
  const report = useQuery({
    queryKey: ['reports', def.key, query],
    queryFn: () => api.get<ReportResult>(`/api/reports/${def.key}?${query}`),
    placeholderData: (prev) => prev,
  });
  const r = report.data;

  const presets: { label: string; from: string; to: string }[] = [
    { label: 'Today', from: today, to: today },
    { label: 'This month', from: monthStart(today), to: today },
    { label: 'This fiscal year', from: `${fiscalYearStartOf(today, startMonth)}-${String(startMonth).padStart(2, '0')}-01`, to: today },
  ];
  const fyNow = fiscalYearStartOf(today, calendar ? 1 : startMonth);
  const years = Array.from({ length: 6 }, (_, i) => fyNow - i);

  return (
    <div>
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 pt-4">
          {has('period') && (
            <>
              <label className="text-sm">
                From <Input type="date" className="w-40" value={from} max={today} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
              </label>
              <label className="text-sm">
                To <Input type="date" className="w-40" value={to} max={today} onChange={(e) => setTo(e.target.value)} aria-label="To" />
              </label>
              <div className="flex gap-1">
                {presets.map((p) => (
                  <Button
                    key={p.label}
                    variant={from === p.from && to === p.to ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => {
                      setFrom(p.from);
                      setTo(p.to);
                    }}
                  >
                    {p.label}
                  </Button>
                ))}
              </div>
            </>
          )}
          {has('as_of') && (
            <label className="text-sm">
              On <Input type="date" className="w-40" value={asOf} max={today} onChange={(e) => setAsOf(e.target.value)} aria-label="As of date" />
            </label>
          )}
          {has('party') && (
            <NativeSelect className="w-56" value={party} onChange={(e) => setParty(e.target.value)} aria-label="Customers or suppliers">
              <option value="all">Customers and suppliers</option>
              <option value="customers">Customers only</option>
              <option value="suppliers">Suppliers only</option>
            </NativeSelect>
          )}
          {has('fiscal_year') && (
            <>
              <NativeSelect className="w-36" value={fy} onChange={(e) => setFy(e.target.value)} aria-label="Year">
                <option value="">{calendar ? 'This year' : 'This fiscal year'}</option>
                {years.map((y) => (
                  <option key={y} value={y}>
                    {calendar || startMonth === 1 ? y : `${y}-${String(y + 1).slice(2)}`}
                  </option>
                ))}
              </NativeSelect>
              {startMonth !== 1 && (
                <label className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={calendar} onChange={(e) => setCalendar(e.target.checked)} /> Calendar year
                </label>
              )}
            </>
          )}
          {has('compare') && (
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} /> Compare with the year before
            </label>
          )}
          {def.groupBy && (
            <NativeSelect className="w-52" value={groupBy} onChange={(e) => setGroupBy(e.target.value)} aria-label="Group by">
              {def.groupBy.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.value === 'changed' || g.value === 'list' ? g.label : `By ${g.label.toLowerCase()}`}
                </option>
              ))}
            </NativeSelect>
          )}
          {def.show && (
            <NativeSelect className="w-60" value={show} onChange={(e) => setShow(e.target.value)} aria-label="Show">
              {def.show.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </NativeSelect>
          )}
          {has('inactive_days') && show === 'inactive' && (
            <label className="text-sm">
              N = <Input className="inline-block w-20 text-right" inputMode="numeric" value={inactiveDays} onChange={(e) => setInactiveDays(e.target.value.replace(/\D/g, ''))} aria-label="Inactive days" /> days
            </label>
          )}
          {has('type') && (
            <NativeSelect className="w-36" value={type} onChange={(e) => setType(e.target.value)} aria-label="Customer type">
              <option value="">All types</option>
              <option value="wholesaler">Wholesalers</option>
              <option value="retailer">Retailers</option>
            </NativeSelect>
          )}
          {has('city') && (
            <NativeSelect className="w-36" value={city} onChange={(e) => setCity(e.target.value)} aria-label="City">
              <option value="">All cities</option>
              {(cities.data ?? []).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </NativeSelect>
          )}
          {has('customer') && fixed.customer_id === undefined && (
            <Button variant="outline" onClick={() => (customer ? setCustomer(null) : setPicking(true))}>
              {customer ? (
                <>
                  {customer.name} <X />
                </>
              ) : (
                'All customers'
              )}
            </Button>
          )}
          {has('category') && (
            <NativeSelect className="w-40" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
              <option value="">All categories</option>
              {(categories.data ?? []).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </NativeSelect>
          )}
          {has('expense_category') && (
            <NativeSelect className="w-48" value={expenseCategory} onChange={(e) => setExpenseCategory(e.target.value)} aria-label="Expense category">
              <option value="">All expense categories</option>
              {(expenseCats.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </NativeSelect>
          )}
          {has('method') && (
            <NativeSelect className="w-36" value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Cash or bank">
              <option value="">{def.key === 'cash-bank-book' ? 'Cash and bank' : 'All methods'}</option>
              <option value="cash">Cash</option>
              <option value="bank">Bank</option>
              {def.key === 'money-book' && <option value="cheque">Cheque</option>}
              {def.key === 'money-book' && <option value="online">Online</option>}
            </NativeSelect>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="outline" onClick={() => window.open(`/api/reports/${def.key}?${qs({ ...params, format: 'pdf' })}`, '_blank')}>
              <Printer /> Print / PDF
            </Button>
            <Button variant="outline" asChild>
              <a href={`/api/reports/${def.key}?${qs({ ...params, format: 'csv' })}`} download>
                <FileDown /> Export CSV
              </a>
            </Button>
          </div>
        </CardContent>
      </Card>

      {report.isError && <p className="font-medium text-destructive">{errorMessage(report.error)}</p>}
      {r && (
        <>
          {!compact && <p className="mb-3 text-muted-foreground">{r.subtitle}</p>}
          {r.summary.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-3">
              {r.summary.map((s) => (
                <Card key={s.label}>
                  <CardContent className="px-4 py-3">
                    <div className="text-sm text-muted-foreground">{s.label}</div>
                    <div className={cn('amount text-left text-xl font-bold', typeof s.value === 'number' && s.value < 0 && s.kind === 'money' && 'text-destructive')}>{cellText(s.value, s.kind)}</div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
          <ReportTable r={r} onOpen={(link) => navigate(link)} />
          {r.notes.length > 0 && (
            <ul className="mt-2 text-sm text-muted-foreground">
              {r.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </>
      )}
      <CustomerPicker open={picking} onOpenChange={setPicking} onSelect={setCustomer} />
    </div>
  );
}

function ReportTable({ r, onOpen }: { r: ReportResult; onOpen: (link: string) => void }) {
  const kindFor = (row: ReportRow, k: ReportKind): ReportKind => (k === 'money' && row._kind ? (row._kind as ReportKind) : k);
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead className="bg-muted text-left text-muted-foreground">
          <tr>
            {r.columns.map((c) => (
              <th key={c.key} className={cn('px-3 py-2 whitespace-nowrap', numeric(c.kind) && 'text-right')}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {r.rows.map((row, i) => (
            <tr
              key={i}
              className={cn('border-t border-border', row._strong && 'bg-muted/40 font-semibold', row._link && 'cursor-pointer hover:bg-muted/60')}
              onClick={() => row._link && onOpen(row._link)}
              tabIndex={row._link ? 0 : undefined}
              onKeyDown={(e) => e.key === 'Enter' && row._link && onOpen(row._link)}
            >
              {r.columns.map((c) => {
                const k = kindFor(row, c.kind);
                const v = row[c.key];
                return (
                  <td key={c.key} className={cn('px-3 py-1.5', numeric(k) ? 'amount whitespace-nowrap' : '', typeof v === 'number' && v < 0 && k === 'money' && 'text-destructive')}>
                    {cellText(v, k)}
                  </td>
                );
              })}
            </tr>
          ))}
          {r.rows.length === 0 && (
            <tr>
              <td colSpan={r.columns.length} className="px-3 py-8 text-center text-muted-foreground">
                Nothing to show for these filters.
              </td>
            </tr>
          )}
        </tbody>
        {r.totals && r.rows.length > 0 && (
          <tfoot className="border-t-2 border-border font-semibold">
            <tr>
              {r.columns.map((c, i) => (
                <td key={c.key} className={cn('px-3 py-2', numeric(c.kind) && 'amount whitespace-nowrap')}>
                  {i === 0 && r.totals?.[c.key] === undefined ? 'Total' : cellText(r.totals?.[c.key], c.kind)}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
