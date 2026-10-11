import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ASSET_CATEGORIES, formatPaisa, paisaToInput, parseRupeesToPaisa, type Asset } from '@shopledger/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { FormField } from '@/components/FormField';
import { MoneyInput } from '@/components/inputs';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, NativeSelect } from '@/components/ui/input';
import { ChangeReasonField, changeReasonOk } from '@/features/documents';
import { api, ApiError, errorMessage } from '@/lib/api';
import { todayKarachi } from '@/lib/utils';
import { ASSETS_KEY, CATEGORY_LABEL } from './api';

/** Add an asset, or (with `asset`) edit one with a reason. */
export function AssetFormDialog({ asset, onClose, onSaved }: { asset?: Asset; onClose: () => void; onSaved?: (a: Asset) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(asset?.name ?? '');
  const [category, setCategory] = useState<Asset['category']>(asset?.category ?? 'equipment');
  const [date, setDate] = useState(asset?.purchase_date ?? todayKarachi());
  const [cost, setCost] = useState(asset ? paisaToInput(asset.cost_paisa) : '');
  const [method, setMethod] = useState<'cash' | 'bank'>(asset?.method ?? 'cash');
  const [vendor, setVendor] = useState(asset?.vendor ?? '');
  const [depreciates, setDepreciates] = useState((asset?.depreciation_method ?? 'straight_line') === 'straight_line');
  const [life, setLife] = useState(asset?.useful_life_months ? String(asset.useful_life_months) : '36');
  const [salvage, setSalvage] = useState(asset ? paisaToInput(asset.salvage_value_paisa) : '0');
  const [notes, setNotes] = useState(asset?.notes ?? '');
  const [changeReason, setChangeReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const costPaisa = parseRupeesToPaisa(cost);
  const salvagePaisa = parseRupeesToPaisa(salvage || '0');
  const lifeMonths = Number(life);
  const monthly = depreciates && costPaisa !== null && salvagePaisa !== null && lifeMonths > 0 ? Math.ceil((costPaisa - salvagePaisa) / lifeMonths) : null;

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name,
        category,
        purchase_date: date,
        cost_paisa: costPaisa,
        method,
        vendor,
        depreciation_method: depreciates ? 'straight_line' : 'none',
        useful_life_months: depreciates ? lifeMonths : null,
        salvage_value_paisa: depreciates ? salvagePaisa : 0,
        notes,
      };
      return asset ? api.put<{ asset: Asset }>(`/api/assets/${asset.id}`, { ...body, change_reason: changeReason }) : api.post<{ asset: Asset }>('/api/assets', body);
    },
    onSuccess: ({ asset: saved }) => {
      void qc.invalidateQueries({ queryKey: ASSETS_KEY });
      toast.success(asset ? `${saved.doc_no} updated.` : `${saved.doc_no} added.`);
      onSaved?.(saved);
      onClose();
    },
    onError: (e) => setError(e instanceof ApiError && e.fields ? (Object.values(e.fields)[0] ?? errorMessage(e)) : errorMessage(e)),
  });

  const submit = () => {
    setError(null);
    if (!name.trim()) return setError('Enter a name.');
    if (costPaisa === null || costPaisa <= 0) return setError('Enter the cost.');
    if (depreciates && (!Number.isInteger(lifeMonths) || lifeMonths <= 0)) return setError('Enter the useful life in months.');
    if (depreciates && (salvagePaisa === null || salvagePaisa > costPaisa)) return setError('Salvage value must be between 0 and the cost.');
    if (asset && !changeReasonOk(changeReason)) return setError('Enter the reason for the change.');
    save.mutate();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{asset ? `Edit ${asset.doc_no}` : 'Add asset'}</DialogTitle>
          <DialogDescription>Something the business owns and uses for more than a year. Its cost is not an expense; its depreciation reduces net profit.</DialogDescription>
        </DialogHeader>
        <form
          className="grid grid-cols-1 gap-4 md:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="md:col-span-2">
            <FormField label="Name" htmlFor="as_name">
              <Input id="as_name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Dell laptop, shop counter" />
            </FormField>
          </div>
          <FormField label="Type" htmlFor="as_category">
            <NativeSelect id="as_category" value={category} onChange={(e) => setCategory(e.target.value as Asset['category'])}>
              {ASSET_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABEL[c]}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField label="Purchase date" htmlFor="as_date">
            <Input id="as_date" type="date" max={todayKarachi()} value={date} onChange={(e) => setDate(e.target.value)} />
          </FormField>
          <FormField label="Cost" htmlFor="as_cost">
            <MoneyInput id="as_cost" value={cost} onChange={(e) => setCost(e.target.value)} />
          </FormField>
          <FormField label="Paid by" htmlFor="as_method">
            <NativeSelect id="as_method" value={method} onChange={(e) => setMethod(e.target.value as 'cash' | 'bank')}>
              <option value="cash">Cash</option>
              <option value="bank">Bank</option>
            </NativeSelect>
          </FormField>
          <div className="md:col-span-2">
            <FormField label="Bought from" htmlFor="as_vendor">
              <Input id="as_vendor" value={vendor} onChange={(e) => setVendor(e.target.value)} />
            </FormField>
          </div>
          <label className="flex items-center gap-2 font-medium md:col-span-2">
            <input type="checkbox" checked={depreciates} onChange={(e) => setDepreciates(e.target.checked)} /> Depreciate (straight line, monthly)
          </label>
          {depreciates && (
            <>
              <FormField label="Useful life (months)" htmlFor="as_life" hint={monthly !== null && monthly > 0 ? `About ${formatPaisa(monthly)} a month, from the month after purchase.` : undefined}>
                <Input id="as_life" inputMode="numeric" className="amount" value={life} onChange={(e) => setLife(e.target.value.replace(/\D/g, ''))} />
              </FormField>
              <FormField label="Salvage value" htmlFor="as_salvage" hint="What it will be worth at the end. Often 0.">
                <MoneyInput id="as_salvage" value={salvage} onChange={(e) => setSalvage(e.target.value)} />
              </FormField>
            </>
          )}
          <div className="md:col-span-2">
            <FormField label="Notes" htmlFor="as_notes">
              <Input id="as_notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </FormField>
          </div>
          {asset && (
            <div className="md:col-span-2">
              <ChangeReasonField id="as_change_reason" value={changeReason} onChange={setChangeReason} />
            </div>
          )}
          {error && <p className="font-medium text-destructive md:col-span-2">{error}</p>}
          <DialogFooter className="md:col-span-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {asset ? 'Save changes' : 'Add asset'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Sold or scrapped: date, amount received and reason. The gain or loss goes into net profit. */
export function DisposeAssetDialog({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const qc = useQueryClient();
  const [date, setDate] = useState(todayKarachi());
  const [amount, setAmount] = useState('0');
  const [method, setMethod] = useState<'cash' | 'bank'>('cash');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const amountPaisa = parseRupeesToPaisa(amount || '0');
  const save = useMutation({
    mutationFn: () => api.post<{ asset: Asset }>(`/api/assets/${asset.id}/dispose`, { date, amount_paisa: amountPaisa, method, reason }),
    onSuccess: ({ asset: a }) => {
      void qc.invalidateQueries({ queryKey: ASSETS_KEY });
      const g = a.disposal_gain_paisa ?? 0;
      toast.success(`${a.doc_no} disposed of: ${g >= 0 ? `gain ${formatPaisa(g)}` : `loss ${formatPaisa(-g)}`}.`);
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Dispose of {asset.name}</DialogTitle>
          <DialogDescription>
            Book value today {formatPaisa(asset.book_value_paisa)}. Depreciation stops; the gain or loss (amount received − book value on that date) goes into net profit.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid grid-cols-2 gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            if (amountPaisa === null) return setError('Enter the amount received (0 if scrapped).');
            if (reason.trim().length < 3) return setError('Enter a reason.');
            save.mutate();
          }}
        >
          <FormField label="Date" htmlFor="ad_date">
            <Input id="ad_date" type="date" min={asset.purchase_date} max={todayKarachi()} value={date} onChange={(e) => setDate(e.target.value)} />
          </FormField>
          <FormField label="Amount received" htmlFor="ad_amount" hint="0 if scrapped or given away.">
            <MoneyInput id="ad_amount" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} />
          </FormField>
          <FormField label="Received by" htmlFor="ad_method">
            <NativeSelect id="ad_method" value={method} onChange={(e) => setMethod(e.target.value as 'cash' | 'bank')}>
              <option value="cash">Cash</option>
              <option value="bank">Bank</option>
            </NativeSelect>
          </FormField>
          <FormField label="Reason" htmlFor="ad_reason">
            <Input id="ad_reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Sold, broken" />
          </FormField>
          {error && <p className="col-span-2 font-medium text-destructive">{error}</p>}
          <DialogFooter className="col-span-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              Dispose
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
