import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatPaisa, formatPhone, REPORTS, type Customer, type LedgerLine, type ReportDef, type WriteOff } from '@shopledger/shared';
import { ArrowLeft, Ban, Eraser, FileText, HandCoins, Pencil, ShieldAlert, ShieldCheck, UserCheck } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { Balance, CustomerStatusBadge } from '@/components/badges';
import { FullPageMessage } from '@/components/FullPageMessage';
import { ReasonDialog } from '@/components/ReasonDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SalesTable } from '@/features/sales/SalesTable';
import { openStatement, useWriteOffs } from '@/features/payments/api';
import { PaymentsTable } from '@/features/payments/PaymentsTable';
import { ReceivePaymentDialog } from '@/features/payments/ReceivePaymentDialog';
import { SalesReturnsTable } from '@/features/payments/SalesReturnsTable';
import { WriteOffDialog } from '@/features/payments/WriteOffDialog';
import { VoidButton } from '@/features/documents';
import { ReportView } from '@/features/reports/ReportView';

const reportDef = (key: string) => REPORTS.find((r) => r.key === key) as ReportDef;
import { useCan } from '@/features/auth/useAuth';
import { CUSTOMERS_KEY, useCustomer, useCustomerLedger } from '@/features/customers/api';
import { CustomerFormDialog } from '@/features/customers/CustomerFormDialog';
import { OverdueBadge } from '@/features/overdue';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';

const ENTRY_LABEL: Record<LedgerLine['entry_type'], string> = {
  opening_balance: 'Opening balance',
  sale: 'Sale',
  receipt: 'Payment received',
  sales_return: 'Return',
  write_off: 'Write-off',
  write_off_reversal: 'Write-off reversed',
  bounced_cheque: 'Cheque bounced',
  refund: 'Refund paid',
  purchase: 'Purchase',
  supplier_payment: 'Payment',
  purchase_return: 'Purchase return',
};

export function CustomerDetailPage() {
  const id = Number(useParams().id);
  const can = useCan();
  const qc = useQueryClient();
  const { data: c, isPending, isError, error } = useCustomer(id);
  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState<'mark' | 'clear' | 'deactivate' | 'pay' | 'write_off' | null>(null);

  const action = useMutation({
    mutationFn: ({ kind, reason }: { kind: 'mark' | 'clear' | 'deactivate' | 'activate'; reason?: string }) => {
      if (kind === 'mark') return api.post(`/api/customers/${id}/bad-debt`, { reason });
      if (kind === 'clear') return api.post(`/api/customers/${id}/bad-debt/clear`, { reason });
      return api.patch(`/api/customers/${id}`, { active: kind === 'activate', ...(reason ? { reason } : {}) });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CUSTOMERS_KEY });
      setDialog(null);
      toast.success('Customer updated.');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (isPending) return <p>Loading…</p>;
  if (isError) return <FullPageMessage inline title="Customer not found" detail={errorMessage(error)} />;

  const creditUsed = c.credit_limit_paisa > 0 ? Math.round((Math.max(c.balance_paisa, 0) * 100) / c.credit_limit_paisa) : null;

  return (
    <div>
      <Link to="/customers" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Customers
      </Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-3 text-2xl font-bold">
            {c.name} <CustomerStatusBadge status={c.status} />
          </h1>
          <p className="text-muted-foreground">
            {[c.code, c.business_name, c.type === 'wholesaler' ? 'Wholesaler' : 'Retailer', c.city].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {can('payments.create') && (
            <Button onClick={() => setDialog('pay')}>
              <HandCoins /> Record payment
            </Button>
          )}
          {can('write_offs.manage') && c.balance_paisa > 0 && (
            <Button variant="outline" onClick={() => setDialog('write_off')}>
              <Eraser /> Write off
            </Button>
          )}
          {can('customers.manage') && (
            <Button variant="outline" onClick={() => setEditing(true)}>
              <Pencil /> Edit
            </Button>
          )}
          {can('customers.bad_debt') && c.status !== 'bad_debt' && c.status !== 'inactive' && (
            <Button variant="outline" onClick={() => setDialog('mark')}>
              <ShieldAlert /> Mark bad debt
            </Button>
          )}
          {can('customers.bad_debt') && c.status === 'bad_debt' && (
            <Button variant="outline" onClick={() => setDialog('clear')}>
              <ShieldCheck /> Clear bad debt
            </Button>
          )}
          {can('customers.manage') && c.status !== 'inactive' && (
            <Button variant="ghost" onClick={() => setDialog('deactivate')}>
              <Ban /> Deactivate
            </Button>
          )}
          {can('customers.manage') && c.status === 'inactive' && (
            <Button variant="outline" onClick={() => action.mutate({ kind: 'activate' })}>
              <UserCheck /> Activate
            </Button>
          )}
        </div>
      </div>

      {c.status === 'bad_debt' && (
        <div className="mb-4 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-red-900">
          <strong>Bad debt</strong> since {c.bad_debt_marked_at ? formatDateTime(c.bad_debt_marked_at) : '—'}: {c.bad_debt_reason}. New credit sales need
          owner confirmation.
        </div>
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Balance">
          <Balance paisa={c.balance_paisa} className="text-xl" />
          <OverdueBadge paisa={c.overdue_paisa} days={c.overdue_days} className="ml-2" />
        </Stat>
        <Stat label="Credit limit">
          {c.credit_limit_paisa ? (
            <>
              <span className="amount text-xl">{formatPaisa(c.credit_limit_paisa)}</span>
              <span className={creditUsed !== null && creditUsed > 100 ? 'ml-2 text-sm font-semibold text-destructive' : 'ml-2 text-sm text-muted-foreground'}>
                {creditUsed}% used
              </span>
            </>
          ) : (
            <span className="text-xl text-muted-foreground">No limit</span>
          )}
        </Stat>
        <Stat label="Payment terms">
          <span className="text-xl">{c.payment_terms_days} days</span>
        </Stat>
        <Stat label="Phone">
          <span className="text-xl">{formatPhone(c.phone) || '—'}</span>
        </Stat>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="ledger">Ledger</TabsTrigger>
          <TabsTrigger value="invoices">Invoices</TabsTrigger>
          <TabsTrigger value="payments">Payments</TabsTrigger>
          <TabsTrigger value="returns">Returns</TabsTrigger>
          <TabsTrigger value="items">Items bought</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
          {can('finance.view') && <TabsTrigger value="profit">Profit</TabsTrigger>}
        </TabsList>
        <TabsContent value="overview">
          <Overview c={c} />
        </TabsContent>
        <TabsContent value="ledger">
          <LedgerTab id={c.id} />
        </TabsContent>
        <TabsContent value="invoices">
          <SalesTable customerId={c.id} />
        </TabsContent>
        <TabsContent value="payments">
          <PaymentsTable customerId={c.id} />
          <WriteOffsCard c={c} />
        </TabsContent>
        <TabsContent value="returns">
          <SalesReturnsTable customerId={c.id} />
        </TabsContent>
        <TabsContent value="items">
          <ReportView def={reportDef('items-bought')} fixed={{ customer_id: c.id }} compact />
        </TabsContent>
        <TabsContent value="notes">
          <Card>
            <CardContent className="whitespace-pre-wrap pt-5">{c.notes || <span className="text-muted-foreground">No notes.</span>}</CardContent>
          </Card>
        </TabsContent>
        {can('finance.view') && (
          <TabsContent value="profit">
            <ReportView def={reportDef('gross-profit')} fixed={{ customer_id: c.id }} compact />
          </TabsContent>
        )}
      </Tabs>

      {editing && <CustomerFormDialog customer={c} onClose={() => setEditing(false)} />}
      {dialog === 'pay' && <ReceivePaymentDialog customer={c} onClose={() => setDialog(null)} />}
      {dialog === 'write_off' && <WriteOffDialog mode="create" customerId={c.id} customerName={c.name} max={c.balance_paisa} onClose={() => setDialog(null)} />}
      {dialog === 'mark' && (
        <ReasonDialog
          title={`Mark ${c.name} as bad debt?`}
          description="A red badge will show wherever this customer appears, and new credit sales will need owner confirmation."
          confirmLabel="Mark bad debt"
          destructive
          pending={action.isPending}
          onConfirm={(reason) => action.mutate({ kind: 'mark', reason })}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'clear' && (
        <ReasonDialog
          title={`Clear bad debt for ${c.name}?`}
          confirmLabel="Clear bad debt"
          pending={action.isPending}
          onConfirm={(reason) => action.mutate({ kind: 'clear', reason })}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'deactivate' && (
        <ReasonDialog
          title={`Deactivate ${c.name}?`}
          description="The customer is hidden from searches but all records are kept. You can activate them again later."
          confirmLabel="Deactivate"
          destructive
          pending={action.isPending}
          onConfirm={(reason) => action.mutate({ kind: 'deactivate', reason })}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className="mt-1">{children}</div>
      </CardContent>
    </Card>
  );
}

function Overview({ c }: { c: Customer }) {
  const rows: [string, React.ReactNode][] = [
    ['Code', c.code],
    ['Name', c.name],
    ['Business name', c.business_name],
    ['Type', c.type === 'wholesaler' ? 'Wholesaler' : 'Retailer'],
    ['Phone', formatPhone(c.phone)],
    ['Other phone', formatPhone(c.alt_phone)],
    ['City', c.city],
    ['Area / market', c.area],
    ['Address', c.address],
    ['NTN', c.ntn],
    ['Opening balance', c.opening_balance_paisa ? <Balance paisa={c.opening_balance_paisa} /> : '—'],
    ['Customer since', formatDateTime(c.created_at)],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Details</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-1 gap-x-8 gap-y-2 md:grid-cols-2">
          {rows.map(([k, v]) => (
            <div key={k} className="flex gap-3 border-b border-border py-1.5">
              <dt className="w-36 shrink-0 text-muted-foreground">{k}</dt>
              <dd>{v || '—'}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function LedgerTab({ id }: { id: number }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { data, isPending, isError, error } = useCustomerLedger(id, { from: from || undefined, to: to || undefined });
  return (
    <div>
      <div className="mb-3 flex items-end gap-3">
        <label className="text-sm">
          From <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-44" />
        </label>
        <label className="text-sm">
          To <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-44" />
        </label>
        <Button variant="outline" className="ml-auto" onClick={() => openStatement('customers', id, { from: from || undefined, to: to || undefined })}>
          <FileText /> Statement PDF
        </Button>
      </div>
      {isPending && <p>Loading…</p>}
      {isError && <p className="text-destructive">{errorMessage(error)}</p>}
      {data && (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-[15px]">
            <thead className="bg-muted text-left text-sm text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Details</th>
                <th className="px-3 py-2 text-right">Debit</th>
                <th className="px-3 py-2 text-right">Credit</th>
                <th className="px-3 py-2 text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-border bg-muted/40">
                <td className="px-3 py-2" colSpan={4}>
                  Balance brought forward
                </td>
                <td className="px-3 py-2 text-right">
                  <Balance paisa={data.opening_balance_paisa} />
                </td>
              </tr>
              {data.lines.map((l) => (
                <tr key={l.id} className="border-t border-border">
                  <td className="px-3 py-2 whitespace-nowrap">{l.date}</td>
                  <td className="px-3 py-2">{l.narration || ENTRY_LABEL[l.entry_type]}</td>
                  <td className="amount px-3 py-2">{l.debit_paisa ? formatPaisa(l.debit_paisa) : ''}</td>
                  <td className="amount px-3 py-2">{l.credit_paisa ? formatPaisa(l.credit_paisa) : ''}</td>
                  <td className="px-3 py-2 text-right">
                    <Balance paisa={l.balance_paisa} />
                  </td>
                </tr>
              ))}
              <tr className="border-t-2 border-border font-bold">
                <td className="px-3 py-2" colSpan={4}>
                  Closing balance
                </td>
                <td className="px-3 py-2 text-right">
                  <Balance paisa={data.closing_balance_paisa} />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Write-offs of this customer; owner+ can take part of one back when the customer pays after all. */
function WriteOffsCard({ c }: { c: Customer }) {
  const can = useCan();
  const { data } = useWriteOffs(c.id);
  const [reversing, setReversing] = useState<WriteOff | null>(null);
  const [editing, setEditing] = useState<WriteOff | null>(null);
  if (!data || data.length === 0) return null;
  return (
    <Card className="mt-5">
      <CardHeader>
        <CardTitle>Written off</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2">
          {data.map((w) => {
            const left = w.amount_paisa - w.reversed_paisa;
            return (
              <li key={w.id} className="flex flex-wrap items-center gap-3">
                <span className="font-mono font-semibold">{w.doc_no}</span>
                {w.status === 'void' && <Badge variant="grey">VOID</Badge>}
                <span>{w.date}</span>
                <span className="text-muted-foreground">{w.reason}</span>
                <span className="amount ml-auto">{formatPaisa(w.amount_paisa)}</span>
                {w.reversed_paisa > 0 && <span className="text-sm text-green-800">{formatPaisa(w.reversed_paisa)} taken back</span>}
                {can('write_offs.manage') && w.status === 'posted' && (
                  <Button variant="ghost" size="sm" onClick={() => setEditing(w)}>
                    Edit
                  </Button>
                )}
                {can('documents.edit_any') && w.status === 'posted' && (
                  <VoidButton size="sm" url={`/api/write-offs/${w.id}/void`} docNo={w.doc_no} description="The customer owes the amount again; any reversals of it go too." />
                )}
                {can('write_offs.manage') && w.status === 'posted' && left > 0 && (
                  <Button variant="outline" size="sm" onClick={() => setReversing(w)}>
                    Customer paid — reverse
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
      {editing && (
        <WriteOffDialog
          mode="edit"
          customerId={c.id}
          customerName={c.name}
          // Up to what the customer would owe without this write-off (reversals are already in the balance).
          max={c.balance_paisa + editing.amount_paisa}
          writeOff={editing}
          onClose={() => setEditing(null)}
        />
      )}
      {reversing && (
        <WriteOffDialog mode="reverse" customerId={c.id} customerName={c.name} max={reversing.amount_paisa - reversing.reversed_paisa} writeOff={reversing} onClose={() => setReversing(null)} />
      )}
    </Card>
  );
}
