import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatPaisa, paisaToInput, parseRupeesToPaisa, type Expense } from '@shopledger/shared';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { FormField } from '@/components/FormField';
import { MoneyInput } from '@/components/inputs';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, NativeSelect } from '@/components/ui/input';
import { ChangeReasonField, changeReasonOk, useDocRights, VoidButton } from '@/features/documents';
import { EXPENSES_KEY, useExpenseCategories, useExpenses } from '@/features/expenses/api';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useHotkey } from '@/lib/useHotkey';
import { formatDateTime, todayKarachi } from '@/lib/utils';

interface FormState {
  date: string;
  category_id: string;
  amount: string;
  method: 'cash' | 'bank';
  paid_to: string;
  reference: string;
  notes: string;
}

const blank = (date = todayKarachi()): FormState => ({ date, category_id: '', amount: '', method: 'cash', paid_to: '', reference: '', notes: '' });

function toBody(f: FormState) {
  return {
    date: f.date,
    category_id: Number(f.category_id),
    amount_paisa: parseRupeesToPaisa(f.amount),
    method: f.method,
    paid_to: f.paid_to,
    reference: f.reference,
    notes: f.notes,
  };
}

function formOk(f: FormState): string | null {
  if (!f.category_id) return 'Pick a category.';
  const a = parseRupeesToPaisa(f.amount);
  if (a === null || a <= 0) return 'Enter the amount.';
  return null;
}

/** The fields of an expense, used by quick entry and the edit dialog. */
function ExpenseFields({ f, set, idPrefix, amountRef }: { f: FormState; set: (p: Partial<FormState>) => void; idPrefix: string; amountRef?: React.Ref<HTMLInputElement> }) {
  const categories = (useExpenseCategories().data ?? []).filter((c) => c.active || String(c.id) === f.category_id);
  return (
    <>
      <FormField label="Date" htmlFor={`${idPrefix}_date`}>
        <Input id={`${idPrefix}_date`} type="date" max={todayKarachi()} value={f.date} onChange={(e) => set({ date: e.target.value })} />
      </FormField>
      <FormField label="Category" htmlFor={`${idPrefix}_category`}>
        <NativeSelect id={`${idPrefix}_category`} value={f.category_id} onChange={(e) => set({ category_id: e.target.value })}>
          <option value="">Pick…</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </NativeSelect>
      </FormField>
      <FormField label="Amount" htmlFor={`${idPrefix}_amount`} error={f.amount && parseRupeesToPaisa(f.amount) === null ? 'Enter an amount in rupees' : undefined}>
        <MoneyInput id={`${idPrefix}_amount`} ref={amountRef} value={f.amount} onChange={(e) => set({ amount: e.target.value })} />
      </FormField>
      <FormField label="Paid by" htmlFor={`${idPrefix}_method`}>
        <NativeSelect id={`${idPrefix}_method`} value={f.method} onChange={(e) => set({ method: e.target.value as FormState['method'] })}>
          <option value="cash">Cash</option>
          <option value="bank">Bank</option>
        </NativeSelect>
      </FormField>
      <FormField label="Paid to" htmlFor={`${idPrefix}_paid_to`}>
        <Input id={`${idPrefix}_paid_to`} value={f.paid_to} onChange={(e) => set({ paid_to: e.target.value })} placeholder="e.g. Landlord, LESCO" />
      </FormField>
      <FormField label="Reference" htmlFor={`${idPrefix}_ref`}>
        <Input id={`${idPrefix}_ref`} value={f.reference} onChange={(e) => set({ reference: e.target.value })} placeholder="Bill or receipt no." />
      </FormField>
      <div className="md:col-span-2">
        <FormField label="Notes" htmlFor={`${idPrefix}_notes`}>
          <Input id={`${idPrefix}_notes`} value={f.notes} onChange={(e) => set({ notes: e.target.value })} />
        </FormField>
      </div>
    </>
  );
}

/** Expenses (CLAUDE.md 10.4), owner and superuser only. */
export function ExpensesPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(blank());
  const amountRef = useRef<HTMLInputElement>(null);
  const set = (p: Partial<FormState>) => setForm((f) => ({ ...f, ...p }));

  const save = useMutation({
    mutationFn: () => api.post<{ expense: Expense }>('/api/expenses', toBody(form)),
    onSuccess: ({ expense }) => {
      void qc.invalidateQueries({ queryKey: EXPENSES_KEY });
      toast.success(`${expense.doc_no} saved: ${expense.category_name} ${formatPaisa(expense.amount_paisa)}.`);
      // Ready for the next one: same date and category, the rest cleared.
      setForm((f) => ({ ...blank(f.date), category_id: f.category_id }));
      amountRef.current?.focus();
    },
    onError: (e) => toast.error(e instanceof ApiError && e.fields ? (Object.values(e.fields)[0] ?? errorMessage(e)) : errorMessage(e)),
  });
  const submit = () => {
    const problem = formOk(form);
    if (problem) return toast.error(problem);
    if (!save.isPending) save.mutate();
  };
  useHotkey('ctrl+s', () => !document.querySelector('[role="dialog"]') && submit());

  return (
    <div className="max-w-6xl">
      <PageHeader title="Expenses" description="Money spent running the business. It reduces net profit; it never touches customer or supplier balances." />
      <Card className="mb-5">
        <CardHeader>
          <CardTitle>Quick entry</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="grid grid-cols-1 gap-4 md:grid-cols-6"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <ExpenseFields f={form} set={set} idPrefix="ex" amountRef={amountRef} />
            <div className="flex items-end md:col-span-2">
              <Button type="submit" disabled={save.isPending} className="w-full">
                {save.isPending ? 'Saving…' : 'Save expense'} <kbd className="text-xs opacity-70">Ctrl+S</kbd>
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
      <ExpenseList />
    </div>
  );
}

function ExpenseList() {
  const categories = useExpenseCategories().data ?? [];
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [category, setCategory] = useState('');
  const [method, setMethod] = useState('');
  const [limit, setLimit] = useState(100);
  const [open, setOpen] = useState<Expense | null>(null);
  const list = useExpenses({ q: q.trim(), from, to, category_id: category, method, limit });
  const data = list.data;
  const rows = data?.expenses ?? [];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Input className="w-56" placeholder="Number, paid to, reference" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search expenses" />
        <label className="text-sm">
          From <Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="text-sm">
          To <Input type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <NativeSelect className="w-48" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Filter by category">
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect className="w-32" value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Filter by cash or bank">
          <option value="">Cash & bank</option>
          <option value="cash">Cash</option>
          <option value="bank">Bank</option>
        </NativeSelect>
      </div>

      {data && (
        <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr]">
          <Card>
            <CardHeader>
              <CardTitle className="flex justify-between">
                By category <span className="amount">{formatPaisa(data.total_paisa)}</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <tbody>
                  {data.by_category.map((c) => (
                    <tr key={c.category_id} className="border-t border-border">
                      <td className="py-1">{c.name}</td>
                      <td className="text-right text-muted-foreground">{c.count}</td>
                      <td className="amount py-1">{formatPaisa(c.total_paisa)}</td>
                    </tr>
                  ))}
                  {data.by_category.length === 0 && (
                    <tr>
                      <td className="py-1 text-muted-foreground">No expenses.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>By month</CardTitle>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <tbody>
                  {data.by_month.map((m) => (
                    <tr key={m.month} className="border-t border-border">
                      <td className="py-1">{m.month}</td>
                      <td className="text-right text-muted-foreground">{m.count}</td>
                      <td className="amount py-1">{formatPaisa(m.total_paisa)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>
      )}

      {list.isError && <p className="text-destructive">{errorMessage(list.error)}</p>}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-[15px]">
          <thead className="bg-muted text-left text-sm text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Number</th>
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2">Paid to</th>
              <th className="px-3 py-2">By</th>
              <th className="px-3 py-2">Reference</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2">Entered by</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} className="cursor-pointer border-t border-border hover:bg-muted/60" tabIndex={0} onClick={() => setOpen(e)} onKeyDown={(ev) => ev.key === 'Enter' && setOpen(e)}>
                <td className="px-3 py-2 whitespace-nowrap">{e.date}</td>
                <td className="px-3 py-2 font-mono font-semibold">
                  {e.doc_no} {e.status === 'void' && <Badge variant="grey">VOID</Badge>}
                </td>
                <td className="px-3 py-2">{e.category_name}</td>
                <td className="px-3 py-2">{e.paid_to}</td>
                <td className="px-3 py-2">{e.method === 'cash' ? 'Cash' : 'Bank'}</td>
                <td className="px-3 py-2">{e.reference}</td>
                <td className={e.status === 'void' ? 'amount px-3 py-2 text-muted-foreground line-through' : 'amount px-3 py-2 font-semibold'}>{formatPaisa(e.amount_paisa)}</td>
                <td className="px-3 py-2 text-sm text-muted-foreground">{e.created_by_name}</td>
              </tr>
            ))}
            {data && rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                  No expenses found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {data && data.total > rows.length && (
        <Button className="mt-3" variant="outline" size="sm" onClick={() => setLimit((l) => l + 100)}>
          Show more ({rows.length} of {data.total})
        </Button>
      )}
      {open && <ExpenseDialog expense={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** One expense: change it (with a reason) or void it. */
function ExpenseDialog({ expense: e, onClose }: { expense: Expense; onClose: () => void }) {
  const qc = useQueryClient();
  const rights = useDocRights(e);
  const [form, setForm] = useState<FormState>({
    date: e.date,
    category_id: String(e.category_id),
    amount: paisaToInput(e.amount_paisa),
    method: e.method,
    paid_to: e.paid_to ?? '',
    reference: e.reference ?? '',
    notes: e.notes ?? '',
  });
  const [changeReason, setChangeReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.put<{ expense: Expense }>(`/api/expenses/${e.id}`, { ...toBody(form), change_reason: changeReason }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: EXPENSES_KEY });
      toast.success(`${e.doc_no} updated.`);
      onClose();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const editable = rights.canEdit;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Expense {e.doc_no} {e.status === 'void' && <Badge variant="grey">VOID</Badge>}
          </DialogTitle>
          <DialogDescription>
            Entered by {e.created_by_name ?? '—'} on {formatDateTime(e.created_at)}
            {e.version > 1 ? ` · version ${e.version}` : ''}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid grid-cols-1 gap-4 md:grid-cols-2"
          onSubmit={(ev) => {
            ev.preventDefault();
            setError(null);
            const problem = formOk(form) ?? (changeReasonOk(changeReason) ? null : 'Enter the reason for the change.');
            if (problem) return setError(problem);
            save.mutate();
          }}
        >
          <fieldset disabled={!editable} className="contents">
            <ExpenseFields f={form} set={(p) => setForm((f) => ({ ...f, ...p }))} idPrefix="exd" />
          </fieldset>
          {editable && (
            <div className="md:col-span-2">
              <ChangeReasonField id="exd_change_reason" value={changeReason} onChange={setChangeReason} />
            </div>
          )}
          {error && <p className="font-medium text-destructive md:col-span-2">{error}</p>}
          <DialogFooter className="md:col-span-2">
            {rights.canVoid && <VoidButton url={`/api/expenses/${e.id}/void`} docNo={e.doc_no} onDone={() => void qc.invalidateQueries({ queryKey: EXPENSES_KEY }).then(onClose)} />}
            <Button type="button" variant="outline" onClick={onClose}>
              Close
            </Button>
            {editable && (
              <Button type="submit" disabled={save.isPending}>
                Save changes
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
