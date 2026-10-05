import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatPaisa, formatPhone, type Customer, type LedgerLine } from '@shopledger/shared';
import { ArrowLeft, Ban, Pencil, ShieldAlert, ShieldCheck, UserCheck } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { Balance, CustomerStatusBadge } from '@/components/badges';
import { FullPageMessage } from '@/components/FullPageMessage';
import { ReasonDialog } from '@/components/ReasonDialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useCan } from '@/features/auth/useAuth';
import { CUSTOMERS_KEY, useCustomer, useCustomerLedger } from '@/features/customers/api';
import { CustomerFormDialog } from '@/features/customers/CustomerFormDialog';
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
  const [dialog, setDialog] = useState<'mark' | 'clear' | 'deactivate' | null>(null);

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
          <Later what="Invoices" phase={4} />
        </TabsContent>
        <TabsContent value="payments">
          <Later what="Payments" phase={5} />
        </TabsContent>
        <TabsContent value="returns">
          <Later what="Returns" phase={5} />
        </TabsContent>
        <TabsContent value="items">
          <Later what="Items bought" phase={5} />
        </TabsContent>
        <TabsContent value="notes">
          <Card>
            <CardContent className="whitespace-pre-wrap pt-5">{c.notes || <span className="text-muted-foreground">No notes.</span>}</CardContent>
          </Card>
        </TabsContent>
        {can('finance.view') && (
          <TabsContent value="profit">
            <Later what="Profit from this customer" phase={5} />
          </TabsContent>
        )}
      </Tabs>

      {editing && <CustomerFormDialog customer={c} onClose={() => setEditing(false)} />}
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

function Later({ what, phase }: { what: string; phase: number }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card py-12 text-center text-muted-foreground">
      {what} will appear here once that part is built (phase {phase}).
    </div>
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
