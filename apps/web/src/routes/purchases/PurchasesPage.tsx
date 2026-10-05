import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatPaisa, formatPhone, paisaToInput, parseRupeesToPaisa, type Supplier } from '@shopledger/shared';
import { Pencil, Plus } from 'lucide-react';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useCan } from '@/features/auth/useAuth';
import { api, ApiError, errorMessage } from '@/lib/api';

const SUPPLIERS_KEY = ['suppliers'] as const;

export function PurchasesPage() {
  return (
    <div>
      <PageHeader title="Purchases" />
      <Tabs defaultValue="supplier">
        <TabsList>
          <TabsTrigger value="purchases">Purchases</TabsTrigger>
          <TabsTrigger value="supplier">Supplier</TabsTrigger>
        </TabsList>
        <TabsContent value="purchases">
          <div className="rounded-lg border border-dashed border-border bg-card py-16 text-center text-muted-foreground">
            Recording purchases arrives in phase 3.
          </div>
        </TabsContent>
        <TabsContent value="supplier">
          <SupplierPanel />
        </TabsContent>
      </Tabs>
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
            {can('suppliers.manage') && (
              <Button variant="outline" size="sm" onClick={() => setEditing(s)}>
                <Pencil /> Edit
              </Button>
            )}
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
