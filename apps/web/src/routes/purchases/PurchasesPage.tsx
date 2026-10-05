import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatPaisa, formatPhone, paisaToInput, parseRupeesToPaisa, type Supplier } from '@shopledger/shared';
import { FileText, Landmark, Pencil, Plus } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { FormField } from '@/components/FormField';
import { MoneyInput } from '@/components/inputs';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useCan } from '@/features/auth/useAuth';
import { usePurchases } from '@/features/purchases/api';
import { openStatement } from '@/features/payments/api';
import { PaySupplierDialog } from '@/features/payments/PaySupplierDialog';
import { api, ApiError, errorMessage } from '@/lib/api';

const SUPPLIERS_KEY = ['suppliers'] as const;

export function PurchasesPage() {
  const can = useCan();
  const navigate = useNavigate();
  return (
    <div>
      <PageHeader
        title="Purchases"
        actions={
          can('purchases.create') && (
            <Button onClick={() => navigate('/purchases/new')}>
              <Plus /> New purchase
            </Button>
          )
        }
      />
      <Tabs defaultValue="purchases">
        <TabsList>
          <TabsTrigger value="purchases">Purchases</TabsTrigger>
          <TabsTrigger value="supplier">Supplier</TabsTrigger>
        </TabsList>
        <TabsContent value="purchases">
          <PurchaseList />
        </TabsContent>
        <TabsContent value="supplier">
          <SupplierPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PurchaseList() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [limit, setLimit] = useState(100);
  const list = usePurchases({ q: q.trim(), from, to, limit });
  const rows = list.data?.purchases ?? [];
  const showCost = rows.some((p) => p.total_cost_paisa !== undefined);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Input className="w-64" placeholder="Purchase no. or supplier bill no." value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="text-sm">
          From <Input type="date" className="w-44" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="text-sm">
          To <Input type="date" className="w-44" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      {list.isError && <p className="text-destructive">{errorMessage(list.error)}</p>}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-[15px]">
          <thead className="bg-muted text-left text-sm text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Number</th>
              <th className="px-3 py-2">Supplier</th>
              <th className="px-3 py-2">Bill no.</th>
              <th className="px-3 py-2 text-right">Lines</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2 text-right">Gross</th>
              {showCost && <th className="px-3 py-2 text-right">Cost</th>}
              <th className="px-3 py-2">Entered by</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr
                key={p.id}
                className="cursor-pointer border-t border-border hover:bg-muted/60"
                tabIndex={0}
                onClick={() => navigate(`/purchases/${p.id}`)}
                onKeyDown={(e) => e.key === 'Enter' && navigate(`/purchases/${p.id}`)}
              >
                <td className="px-3 py-2 whitespace-nowrap">{p.date}</td>
                <td className="px-3 py-2 font-mono font-semibold">
                  {p.doc_no} {p.status === 'void' && <Badge variant="grey">VOID</Badge>}
                </td>
                <td className="px-3 py-2">{p.supplier_name}</td>
                <td className="px-3 py-2">{p.supplier_ref}</td>
                <td className="amount px-3 py-2">{p.item_count}</td>
                <td className="amount px-3 py-2">{p.total_qty}</td>
                <td className="amount px-3 py-2">{formatPaisa(p.gross_paisa)}</td>
                {showCost && <td className="amount px-3 py-2 font-semibold">{formatPaisa(p.total_cost_paisa ?? 0)}</td>}
                <td className="px-3 py-2 text-sm text-muted-foreground">{p.created_by_name}</td>
              </tr>
            ))}
            {list.data && rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">
                  No purchases yet.
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
    </div>
  );
}

function SupplierPanel() {
  const can = useCan();
  const { data, isPending, isError, error } = useQuery({
    queryKey: SUPPLIERS_KEY,
    queryFn: () => api.get<{ suppliers: Supplier[] }>('/api/suppliers').then((r) => r.suppliers),
  });
  const [editing, setEditing] = useState<Supplier | 'new' | null>(null);
  const [paying, setPaying] = useState(false);

  if (isPending) return <p>Loading…</p>;
  if (isError) return <p className="text-destructive">{errorMessage(error)}</p>;

  return (
    <div className="flex flex-col gap-4">
      {data.length === 0 && (
        <Card>
          <CardContent className="flex items-center justify-between pt-5">
            <span className="text-muted-foreground">
              {can('suppliers.manage') ? 'Add the manufacturer you buy from.' : 'The owner has not added the supplier yet.'}
            </span>
            {can('suppliers.manage') && (
              <Button onClick={() => setEditing('new')}>
                <Plus /> Add supplier
              </Button>
            )}
          </CardContent>
        </Card>
      )}
      {data.map((s) => (
        <Card key={s.id} className="max-w-3xl">
          <CardHeader className="flex-row items-start justify-between">
            <CardTitle>{s.name}</CardTitle>
            <div className="flex gap-2">
              {can('payments.create') && s.active && (
                <Button size="sm" onClick={() => setPaying(true)}>
                  <Landmark /> Pay supplier
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => openStatement('suppliers', s.id, {})}>
                <FileText /> Statement PDF
              </Button>
              {can('suppliers.manage') && (
                <Button variant="outline" size="sm" onClick={() => setEditing(s)}>
                  <Pencil /> Edit
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 gap-x-8 gap-y-2 md:grid-cols-2">
              <Row k="Phone" v={formatPhone(s.phone)} />
              <Row k="NTN" v={s.ntn} />
              <Row k="Address" v={s.address} />
              <Row
                k="We owe them"
                v={
                  <span className={s.balance_paisa < 0 ? 'amount font-semibold text-blue-700' : 'amount font-semibold'}>
                    {s.balance_paisa < 0 ? `Advance ${formatPaisa(-s.balance_paisa)}` : formatPaisa(s.balance_paisa)}
                  </span>
                }
              />
              <Row k="Opening balance" v={s.opening_balance_paisa ? `${formatPaisa(s.opening_balance_paisa)} on ${s.opening_balance_date}` : null} />
              <Row k="Notes" v={s.notes} />
            </dl>
          </CardContent>
        </Card>
      ))}
      {paying && <PaySupplierDialog suppliers={data} onClose={() => setPaying(false)} />}
      {editing && <SupplierFormDialog supplier={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex gap-3 border-b border-border py-1.5">
      <dt className="w-36 shrink-0 text-muted-foreground">{k}</dt>
      <dd>{v || '—'}</dd>
    </div>
  );
}

interface FormValues {
  name: string;
  phone: string;
  address: string;
  ntn: string;
  notes: string;
  opening_balance: string;
  opening_balance_date: string;
  reason: string;
}

function SupplierFormDialog({ supplier, onClose }: { supplier?: Supplier; onClose: () => void }) {
  const qc = useQueryClient();
  const form = useForm<FormValues>({
    defaultValues: {
      name: supplier?.name ?? '',
      phone: formatPhone(supplier?.phone),
      address: supplier?.address ?? '',
      ntn: supplier?.ntn ?? '',
      notes: supplier?.notes ?? '',
      opening_balance: supplier ? paisaToInput(supplier.opening_balance_paisa) : '0',
      opening_balance_date: supplier?.opening_balance_date ?? '',
      reason: '',
    },
  });
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => (supplier ? api.patch(`/api/suppliers/${supplier.id}`, body) : api.post('/api/suppliers', body)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: SUPPLIERS_KEY });
      toast.success('Supplier saved.');
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fields) for (const [k, m] of Object.entries(e.fields)) form.setError(k as keyof FormValues, { message: m });
      toast.error(errorMessage(e));
    },
  });
  const onSubmit = form.handleSubmit((v) => {
    const opening = parseRupeesToPaisa(v.opening_balance || '0', { allowNegative: true });
    if (opening === null) return form.setError('opening_balance', { message: 'Enter an amount; use minus for an advance' });
    save.mutate({
      name: v.name,
      phone: v.phone,
      address: v.address,
      ntn: v.ntn,
      notes: v.notes,
      opening_balance_paisa: opening,
      ...(v.opening_balance_date ? { opening_balance_date: v.opening_balance_date } : {}),
      ...(supplier && v.reason.trim() ? { reason: v.reason } : {}),
    });
  });
  const err = form.formState.errors;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{supplier ? 'Edit supplier' : 'Add supplier'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <FormField label="Name" htmlFor="s_name" error={err.name?.message}>
              <Input id="s_name" autoFocus {...form.register('name', { required: 'Enter the supplier name' })} />
            </FormField>
          </div>
          <FormField label="Phone" htmlFor="s_phone" error={err.phone?.message}>
            <Input id="s_phone" inputMode="tel" {...form.register('phone')} />
          </FormField>
          <FormField label="NTN" htmlFor="s_ntn">
            <Input id="s_ntn" {...form.register('ntn')} />
          </FormField>
          <div className="md:col-span-2">
            <FormField label="Address" htmlFor="s_address">
              <Input id="s_address" {...form.register('address')} />
            </FormField>
          </div>
          <FormField label="Opening balance (we owe)" htmlFor="s_opening" error={err.opening_balance?.message} hint="Use minus (−) if you paid in advance.">
            <MoneyInput id="s_opening" {...form.register('opening_balance')} />
          </FormField>
          <FormField label="Opening balance date" htmlFor="s_opening_date" hint="Empty means today.">
            <Input id="s_opening_date" type="date" {...form.register('opening_balance_date')} />
          </FormField>
          <div className="md:col-span-2">
            <FormField label="Notes" htmlFor="s_notes">
              <Textarea id="s_notes" rows={2} {...form.register('notes')} />
            </FormField>
          </div>
          {supplier && (
            <div className="md:col-span-2">
              <FormField label="Reason for change (optional)" htmlFor="s_reason">
                <Input id="s_reason" {...form.register('reason')} />
              </FormField>
            </div>
          )}
          <DialogFooter className="md:col-span-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
