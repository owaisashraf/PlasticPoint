import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addDaysToDate,
  bpToPercentString,
  defaultDiscountBp,
  formatBp,
  formatPaisa,
  formatPhone,
  paisaToInput,
  parsePercentToBp,
  parseRupeesToPaisa,
  saleLineAmounts,
  type ApprovalInput,
  type Customer,
  type Product,
  type Sale,
  type SaleCheckResult,
  type SaleIssue,
} from '@shopledger/shared';
import { Search, Trash2 } from 'lucide-react';
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { Balance, CustomerStatusBadge } from '@/components/badges';
import { ItemEntry } from '@/components/document/ItemEntry';
import type { GridPick } from '@/components/document/SizeColorGrid';
import { FormField } from '@/components/FormField';
import { MoneyInput } from '@/components/inputs';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useCan } from '@/features/auth/useAuth';
import { CUSTOMERS_KEY, useCustomer, usePublicSettings } from '@/features/customers/api';
import { CustomerPicker } from '@/features/customers/CustomerPicker';
import { PRODUCTS_KEY } from '@/features/products/api';
import { OVERDUE_KEY, OverdueBadge } from '@/features/overdue';
import { ChangeReasonField, changeReasonOk } from '@/features/documents';
import { ApprovalDialog } from '@/features/sales/ApprovalDialog';
import { SALES_KEY } from '@/features/sales/api';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useHotkey } from '@/lib/useHotkey';
import { cn, todayKarachi } from '@/lib/utils';

interface Line {
  key: string;
  variant_id: number;
  product_id: number;
  item_code: string;
  name: string;
  color: string;
  size: string;
  unit: string;
  qty: string;
  discount: string;
  /** The operator typed a discount: keep it when the customer changes. */
  touched: boolean;
  price_paisa: number;
  product_discount_bp: number;
  /** Editing: the suggested discount the line was sold with (kept while the customer stays the same). */
  kept_default_bp?: number;
  stock_qty: number;
}

function loadProduct(id: number): Promise<Product> {
  return api.get<{ product: Product }>(`/api/products/${id}`).then((r) => r.product);
}

/** True while any dialog (grid, picker, approval) is open: page shortcuts then stay out of the way. */
const dialogOpen = () => document.querySelector('[role="dialog"]') !== null;

/** Enter moves to the next input in the lines table (CLAUDE.md section 15). */
function nextOnEnter(e: KeyboardEvent<HTMLInputElement>) {
  if (e.key !== 'Enter' || e.ctrlKey) return;
  e.preventDefault();
  const all = [...document.querySelectorAll<HTMLInputElement>('[data-line-input]')];
  const next = all[all.indexOf(e.currentTarget) + 1];
  if (next) {
    next.focus();
    next.select();
  } else document.querySelector<HTMLInputElement>('[aria-label="Item code"]')?.focus();
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** /sales/:id/edit — the New Sale screen in edit mode. */
export function EditSalePage() {
  const id = Number(useParams().id);
  return <NewSalePage key={id} editId={id} />;
}

export function NewSalePage({ editId }: { editId?: number } = {}) {
  const can = useCan();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const settings = usePublicSettings().data;
  const seeProfit = can('finance.view');
  // Edit mode (CLAUDE.md 8.6): load the invoice and its customer.
  const editing = useQuery({
    queryKey: [...SALES_KEY, 'one', editId],
    queryFn: () => api.get<{ sale: Sale }>(`/api/sales/${editId}`).then((r) => r.sale),
    enabled: editId !== undefined,
  });
  const original = editing.data;
  const originalCustomer = useCustomer(original?.customer_id ?? 0, original !== undefined).data;
  const [changeReason, setChangeReason] = useState('');

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [picking, setPicking] = useState(false);
  const [date, setDate] = useState(todayKarachi());
  const [terms, setTerms] = useState('');
  const [notes, setNotes] = useState('');
  const [extra, setExtra] = useState('');
  const [cash, setCash] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [approval, setApproval] = useState<{ issues: SaleIssue[]; share: boolean; error: string | null } | null>(null);

  useHotkey('F2', () => !dialogOpen() && setPicking(true));

  // Fill the form once the invoice being edited has loaded (state set during render, once).
  const [loaded, setLoaded] = useState(false);
  if (editId !== undefined && !loaded && original && originalCustomer) {
    setLoaded(true);
    setCustomer(originalCustomer);
    setDate(original.date);
    setTerms(String(original.payment_terms_days));
    setNotes(original.notes ?? '');
    setExtra(original.extra_discount_paisa ? paisaToInput(original.extra_discount_paisa) : '');
    setLines(
      (original.lines ?? []).map((l) => ({
        key: String(l.variant_id),
        variant_id: l.variant_id,
        product_id: l.product_id,
        item_code: l.item_code,
        name: l.name,
        color: l.color,
        size: l.size,
        unit: l.unit,
        qty: String(l.qty),
        discount: bpToPercentString(l.discount_bp),
        touched: l.discount_overridden,
        // Items already on the invoice keep the price they were sold at.
        price_paisa: l.list_price_paisa,
        product_discount_bp: l.default_discount_bp,
        kept_default_bp: l.default_discount_bp,
        stock_qty: Number.MAX_SAFE_INTEGER,
      })),
    );
  }

  const defaultFor = (productBp: number, c: Customer | null) =>
    defaultDiscountBp({
      productDiscountBp: productBp,
      settingsDiscountBp: settings?.default_customer_discount_bp ?? 0,
      customerType: c?.type ?? 'wholesaler',
      retailReductionBp: settings?.retail_discount_reduction_bp ?? 0,
    });

  /** The suggested discount for a line: kept from the invoice being edited while its customer stays the same. */
  const lineDefault = (l: Line, c: Customer | null) => (l.kept_default_bp !== undefined && c?.id === original?.customer_id ? l.kept_default_bp : defaultFor(l.product_discount_bp, c));

  const chooseCustomer = (c: Customer) => {
    setCustomer(c);
    setTerms(String(c.payment_terms_days));
    // Wholesaler/retailer changes the suggested discount on lines nobody changed by hand.
    setLines((ls) => ls.map((l) => (l.touched ? l : { ...l, discount: bpToPercentString(lineDefault(l, c)) })));
  };

  const addPicks = (product: Product, picks: GridPick[]) => {
    // Pure updater (React may run it twice in development).
    setLines((ls) => {
      let next = ls;
      for (const { variant, qty } of picks) {
        if (next.some((l) => l.variant_id === variant.id)) {
          next = next.map((l) => (l.variant_id === variant.id ? { ...l, qty: String(Number(l.qty || 0) + qty) } : l));
        } else {
          next = [
            ...next,
            {
              key: String(variant.id),
              variant_id: variant.id,
              product_id: product.id,
              item_code: product.item_code,
              name: product.name,
              color: variant.color,
              size: variant.size,
              unit: product.unit,
              qty: String(qty),
              discount: bpToPercentString(defaultFor(product.default_customer_discount_bp, customer)),
              touched: false,
              price_paisa: product.list_price_paisa,
              product_discount_bp: product.default_customer_discount_bp,
              stock_qty: variant.stock_qty,
            },
          ];
        }
      }
      return next;
    });
  };

  const update = (key: string, field: 'qty' | 'discount', value: string) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, [field]: value, ...(field === 'discount' ? { touched: true } : {}) } : l)));

  // --- Amounts (computed here for instant feedback; the server recomputes) ---
  const parsed = lines.map((l) => {
    const qty = Number(l.qty);
    const bp = parsePercentToBp(l.discount);
    if (!Number.isInteger(qty) || qty <= 0 || bp === null || bp > 10_000) return null;
    return { qty, bp, def: lineDefault(l, customer), ...saleLineAmounts(qty, l.price_paisa, bp) };
  });
  const linesValid = lines.length > 0 && parsed.every(Boolean);
  const extraPaisa = extra.trim() ? parseRupeesToPaisa(extra) : 0;
  const cashPaisa = cash.trim() ? parseRupeesToPaisa(cash) : 0;
  const termsDays = Number(terms);
  const termsValid = terms.trim() !== '' && Number.isInteger(termsDays) && termsDays >= 0 && termsDays <= 365;
  const gross = parsed.reduce((a, p) => a + (p?.line_gross_paisa ?? 0), 0);
  const lineDiscount = parsed.reduce((a, p) => a + (p?.line_discount_paisa ?? 0), 0);
  const total = gross - lineDiscount - (extraPaisa ?? 0);
  const amountsValid = extraPaisa !== null && cashPaisa !== null && total >= 0 && (cashPaisa ?? 0) <= total;

  const body = linesValid
    ? {
        ...(customer ? { customer_id: customer.id } : {}),
        date,
        ...(termsValid ? { payment_terms_days: termsDays } : {}),
        notes,
        extra_discount_paisa: extraPaisa ?? 0,
        ...(editId === undefined ? { cash_received_paisa: cashPaisa ?? 0 } : {}),
        lines: lines.map((l, i) => ({ variant_id: l.variant_id, qty: parsed[i]?.qty ?? 0, discount_bp: parsed[i]?.bp ?? 0 })),
      }
    : null;

  // --- Live check: warnings, approval needs and (owner+) profit ---
  const checkBody = useDebounced(body && amountsValid ? JSON.stringify(body) : null, 250);
  const check = useQuery({
    queryKey: ['sale-check', editId, checkBody],
    queryFn: () => api.post<SaleCheckResult>(editId === undefined ? '/api/sales/check' : `/api/sales/${editId}/check`, JSON.parse(checkBody as string)),
    enabled: checkBody !== null,
    placeholderData: (prev) => prev,
    retry: false,
  });
  const result = checkBody !== null ? check.data : undefined;
  const lineIssues = (i: number) => (result?.issues ?? []).filter((x) => x.line_index === i);
  const headerIssues = (result?.issues ?? []).filter((x) => x.line_index === null);

  const save = useMutation({
    mutationFn: (v: { approval?: ApprovalInput; share: boolean }) => {
      const payload = { ...body, customer_id: customer?.id, expected_total_paisa: total, ...(v.approval ? { approval: v.approval } : {}) };
      return editId === undefined
        ? api.post<{ sale: Sale }>('/api/sales', payload)
        : api.put<{ sale: Sale }>(`/api/sales/${editId}`, { ...payload, change_reason: changeReason });
    },
    onSuccess: ({ sale }, v) => {
      setApproval(null);
      void qc.invalidateQueries({ queryKey: SALES_KEY });
      void qc.invalidateQueries({ queryKey: PRODUCTS_KEY });
      void qc.invalidateQueries({ queryKey: CUSTOMERS_KEY });
      void qc.invalidateQueries({ queryKey: OVERDUE_KEY });
      toast.success(editId === undefined ? `Invoice ${sale.doc_no} saved.` : `Invoice ${sale.doc_no} updated (version ${sale.version}).`);
      navigate(`/sales/${sale.id}${v.share ? '?share=1' : ''}`);
    },
    onError: (e, v) => {
      if (e instanceof ApiError && e.code === 'APPROVAL_REQUIRED') {
        const issues = (e.details as { issues?: SaleIssue[] } | undefined)?.issues ?? [];
        setApproval({ issues, share: v.share, error: null });
      } else if (approval && e instanceof ApiError && (e.status === 403 || e.status === 429)) {
        setApproval({ ...approval, error: errorMessage(e) });
      } else {
        setApproval(null);
        toast.error(errorMessage(e));
      }
    },
  });

  const trySave = (share: boolean) => {
    if (save.isPending || approval) return;
    if (!customer) return toast.error('Pick the customer first (F2).');
    if (!linesValid) return toast.error('Add items, and check the highlighted lines: quantity and discount % are needed.');
    if (!termsValid) return toast.error('Payment terms must be 0 to 365 days.');
    if (!amountsValid) return toast.error('Check the extra discount and cash received: they cannot be more than the invoice.');
    if (editId !== undefined && !changeReasonOk(changeReason)) return toast.error('Enter the reason for the change.');
    if (result?.needs_approval) return setApproval({ issues: result.issues, share, error: null });
    save.mutate({ share });
  };

  useHotkey('ctrl+s', () => !dialogOpen() && trySave(false));
  useHotkey('ctrl+enter', () => !dialogOpen() && trySave(true));

  let cashError: string | undefined;
  if (cashPaisa === null) cashError = 'Enter an amount in rupees';
  else if (cashPaisa > total && total >= 0) cashError = 'More than the invoice';

  const creditUsed = customer && customer.credit_limit_paisa > 0 ? Math.round((Math.max(0, customer.balance_paisa) * 100) / customer.credit_limit_paisa) : null;

  return (
    <div className="max-w-6xl">
      <PageHeader
        title={editId === undefined ? 'New sale' : `Edit invoice ${original?.doc_no ?? ''}`}
        description={editId === undefined ? undefined : 'Items already on the invoice keep the price they were sold at. Cash taken at the counter is changed on its receipt.'}
        actions={
          <>
            <Button variant="outline" onClick={() => trySave(true)} disabled={save.isPending} title="Ctrl+Enter">
              Save and share <kbd className="text-xs opacity-70">Ctrl+Enter</kbd>
            </Button>
            <Button onClick={() => trySave(false)} disabled={save.isPending} title="Ctrl+S">
              {save.isPending ? 'Saving…' : 'Save sale'} <kbd className="text-xs opacity-70">Ctrl+S</kbd>
            </Button>
          </>
        }
      />

      <Card className="mb-4">
        <CardContent className="grid grid-cols-1 gap-4 pt-5 md:grid-cols-[2fr_1fr_1fr_1fr]">
          <FormField label="Customer" htmlFor="sa_customer">
            <button
              id="sa_customer"
              type="button"
              onClick={() => setPicking(true)}
              className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-md border border-input bg-card px-3 text-left text-[15px] hover:bg-muted"
            >
              <Search className="size-4 text-muted-foreground" />
              {customer ? (
                <span className="flex min-w-0 items-center gap-2 font-semibold">
                  <span className="truncate">{customer.name}</span> <span className="text-sm font-normal text-muted-foreground">{customer.code}</span>
                  <CustomerStatusBadge status={customer.status} />
                </span>
              ) : (
                <span className="text-muted-foreground">Find customer…</span>
              )}
              <kbd className="ml-auto rounded border border-border px-1 text-xs text-muted-foreground">F2</kbd>
            </button>
          </FormField>
          <FormField label="Date" htmlFor="sa_date">
            <Input id="sa_date" type="date" max={todayKarachi()} value={date} onChange={(e) => setDate(e.target.value)} />
          </FormField>
          <FormField label="Payment terms (days)" htmlFor="sa_terms" error={terms && !termsValid ? '0 to 365 days' : undefined}>
            <Input id="sa_terms" inputMode="numeric" className="amount" value={terms} placeholder={String(settings?.default_payment_terms_days ?? 30)} onChange={(e) => setTerms(e.target.value.replace(/\D/g, ''))} />
          </FormField>
          <FormField label="Due date" htmlFor="sa_due">
            <Input id="sa_due" readOnly tabIndex={-1} className="bg-muted" value={termsValid && date ? addDaysToDate(date, termsDays) : ''} />
          </FormField>
        </CardContent>
        {customer && (
          <CardContent className="grid grid-cols-2 gap-3 border-t border-border pt-4 md:grid-cols-5">
            <Stat label="Outstanding balance">
              <Balance paisa={customer.balance_paisa} />
            </Stat>
            <Stat label="Overdue">
              {customer.overdue_days > 0 ? <OverdueBadge paisa={customer.overdue_paisa} days={customer.overdue_days} className="text-sm" /> : <span className="text-muted-foreground">None</span>}
            </Stat>
            <Stat label="Credit limit">
              {customer.credit_limit_paisa ? (
                <span className={cn('amount', creditUsed !== null && creditUsed > 100 && 'font-semibold text-destructive')}>
                  {formatPaisa(customer.credit_limit_paisa)} · {creditUsed}% used
                </span>
              ) : (
                <span className="text-muted-foreground">No limit</span>
              )}
            </Stat>
            <Stat label="Usual terms">{customer.payment_terms_days} days</Stat>
            <Stat label="Type / city">
              {customer.type === 'retailer' ? 'Retailer' : 'Wholesaler'}
              {customer.city ? ` · ${customer.city}` : ''}
              {customer.phone ? <span className="block text-sm text-muted-foreground">{formatPhone(customer.phone)}</span> : null}
            </Stat>
          </CardContent>
        )}
      </Card>

      {customer?.status === 'bad_debt' && (
        <div className="mb-3 rounded-md border border-red-300 bg-red-50 px-4 py-2 text-red-900">
          <strong>Bad debt customer.</strong> A credit sale needs owner approval. A sale paid in full now does not.
        </div>
      )}
      {checkBody !== null && check.isError && (
        <div className="mb-3 rounded-md border border-red-300 bg-red-50 px-4 py-2 text-red-900">
          The sale could not be checked: {errorMessage(check.error)}
        </div>
      )}
      {headerIssues.map((i) => (
        <div key={i.kind} className={cn('mb-3 rounded-md border px-4 py-2', i.severity === 'approval' ? 'border-red-300 bg-red-50 text-red-900' : 'border-amber-300 bg-amber-50 text-amber-900')}>
          {i.message}
        </div>
      ))}

      <div className="mb-3">
        {/* The suggested discount depends on settings, so items wait until they have loaded. */}
        {settings ? <ItemEntry loadProduct={loadProduct} onAdd={addPicks} warnAboveStock /> : <p className="text-muted-foreground">Loading…</p>}
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-[15px]">
          <thead className="bg-muted text-left text-sm text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Item</th>
              <th className="px-3 py-2">Color</th>
              <th className="px-3 py-2">Size</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2 text-right">Price</th>
              <th className="px-3 py-2 text-right">Discount %</th>
              <th className="px-3 py-2 text-right">Amount</th>
              {seeProfit && <th className="px-3 py-2 text-right">Profit</th>}
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-10 text-center text-muted-foreground">
                  Type an item code above and press Enter to add items.
                </td>
              </tr>
            )}
            {lines.map((l, i) => {
              const p = parsed[i];
              const changed = !!p && p.bp !== p.def;
              const issues = lineIssues(i);
              const needs = issues.some((x) => x.severity === 'approval');
              const checked = result?.lines[i];
              const loss = seeProfit && checked?.profit_paisa !== undefined && checked.profit_paisa < 0;
              return (
                <tr key={l.key} className={cn('border-t border-border align-top', (!p || loss) && 'bg-red-50')}>
                  <td className="px-3 py-1.5">
                    <span className="font-mono font-semibold">{l.item_code}</span> <span className="text-sm text-muted-foreground">{l.name}</span>
                    {issues.map((x) => (
                      <div key={x.kind} className={cn('text-sm font-medium', x.severity === 'approval' ? 'text-destructive' : 'text-amber-700')}>
                        {x.message}
                      </div>
                    ))}
                  </td>
                  <td className="px-3 py-1.5">{l.color || '—'}</td>
                  <td className="px-3 py-1.5">{l.size || '—'}</td>
                  <td className="px-3 py-1.5 text-right">
                    <Input
                      data-line-input
                      className={cn('amount ml-auto h-8 w-20', p && p.qty > l.stock_qty && 'border-amber-500')}
                      inputMode="numeric"
                      value={l.qty}
                      onChange={(e) => update(l.key, 'qty', e.target.value.replace(/\D/g, ''))}
                      onKeyDown={nextOnEnter}
                      title={`${l.stock_qty} in stock`}
                      aria-label={`Quantity ${l.item_code} ${l.color} ${l.size}`}
                    />
                  </td>
                  <td className="amount px-3 py-1.5" title="The product's price. Only the owner can change it, on the product.">
                    {formatPaisa(l.price_paisa)}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <Input
                      data-line-input
                      className={cn('amount ml-auto h-8 w-20', changed && 'border-purple-600 bg-purple-50 font-semibold', needs && 'border-destructive')}
                      inputMode="decimal"
                      value={l.discount}
                      onChange={(e) => update(l.key, 'discount', e.target.value)}
                      onFocus={(e) => e.target.select()}
                      onKeyDown={nextOnEnter}
                      title={changed && p ? `Usual discount is ${formatBp(p.def)}` : undefined}
                      aria-label={`Discount percent ${l.item_code} ${l.color} ${l.size}`}
                    />
                  </td>
                  <td className="amount px-3 py-1.5 font-semibold">{p ? formatPaisa(p.line_amount_paisa) : '—'}</td>
                  {seeProfit && (
                    <td className={cn('amount px-3 py-1.5', loss && 'font-semibold text-destructive')}>
                      {checked?.profit_paisa !== undefined ? formatPaisa(checked.profit_paisa) : '—'}
                      {checked?.cost_source === 'estimated' && (
                        <Badge variant="grey" className="ml-1" title="Nothing bought yet: cost estimated from the supplier margin">
                          est.
                        </Badge>
                      )}
                    </td>
                  )}
                  <td className="px-2">
                    <Button variant="ghost" size="icon" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label="Remove line">
                      <Trash2 />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {lines.length > 0 && <p className="mt-2 text-sm text-muted-foreground">Purple means the discount differs from the usual one. Enter moves to the next box.</p>}

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-[1fr_auto]">
        <div className="grid grid-cols-1 content-start gap-4 md:grid-cols-3">
          <FormField label="Extra discount on invoice" htmlFor="sa_extra" error={extraPaisa === null ? 'Enter an amount in rupees' : undefined}>
            <MoneyInput id="sa_extra" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="0" />
          </FormField>
          {editId === undefined ? (
            <FormField label="Cash received now" htmlFor="sa_cash" error={cashError}>
              <div className="flex gap-2">
                <MoneyInput id="sa_cash" value={cash} onChange={(e) => setCash(e.target.value)} placeholder="0" />
                <Button variant="outline" size="sm" className="h-9" onClick={() => setCash(total > 0 ? paisaToInput(total) : '')} disabled={total <= 0}>
                  Full
                </Button>
              </div>
            </FormField>
          ) : (
            <ChangeReasonField value={changeReason} onChange={setChangeReason} />
          )}
          <FormField label="Notes" htmlFor="sa_notes">
            <Input id="sa_notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </FormField>
        </div>
        <div className="min-w-72 rounded-lg border border-border bg-card p-4">
          <TotalRow label="Gross (qty × price)" value={formatPaisa(gross)} />
          <TotalRow label="Discount" value={`−${formatPaisa(lineDiscount)}`} />
          {(extraPaisa ?? 0) > 0 && <TotalRow label="Extra discount" value={`−${formatPaisa(extraPaisa ?? 0)}`} />}
          <TotalRow label="Total" value={formatPaisa(Math.max(0, total))} strong />
          {(cashPaisa ?? 0) > 0 && <TotalRow label="Cash received" value={`−${formatPaisa(cashPaisa ?? 0)}`} />}
          {(cashPaisa ?? 0) > 0 && <TotalRow label="On credit" value={formatPaisa(Math.max(0, total - (cashPaisa ?? 0)))} />}
          {seeProfit && result?.totals.profit_paisa !== undefined && (
            <div className={cn('mt-2 border-t border-border pt-2', result.totals.profit_paisa < 0 ? 'text-destructive' : 'text-green-800')}>
              <TotalRow label="Profit" value={`${formatPaisa(result.totals.profit_paisa)} (${formatBp(result.totals.profit_bp ?? 0)})`} strong />
            </div>
          )}
        </div>
      </div>

      <CustomerPicker open={picking} onOpenChange={setPicking} onSelect={chooseCustomer} />
      {approval && (
        <ApprovalDialog
          issues={approval.issues}
          selfApprove={can('approvals.grant')}
          pending={save.isPending}
          error={approval.error}
          onCancel={() => setApproval(null)}
          onApprove={(a) => save.mutate({ approval: a, share: approval.share })}
        />
      )}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="font-medium">{children}</div>
    </div>
  );
}

function TotalRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cn('flex justify-between gap-6 py-0.5', strong && 'text-lg font-bold')}>
      <span className={strong ? '' : 'text-muted-foreground'}>{label}</span>
      <span className="amount">{value}</span>
    </div>
  );
}
