import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CUSTOMER_TYPES, formatPhone, paisaToInput, parseRupeesToPaisa, type Customer } from '@shopledger/shared';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { applyServerFieldErrors, FormField } from '@/components/FormField';
import { MoneyInput } from '@/components/inputs';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { api, ApiError, errorMessage } from '@/lib/api';
import { CUSTOMERS_KEY, useCities, usePublicSettings } from './api';

interface FormValues {
  name: string;
  business_name: string;
  type: (typeof CUSTOMER_TYPES)[number];
  phone: string;
  alt_phone: string;
  city: string;
  area: string;
  address: string;
  ntn: string;
  credit_limit: string;
  payment_terms_days: string;
  opening_balance: string;
  opening_balance_date: string;
  notes: string;
  reason: string;
}

const EMPTY: FormValues = {
  name: '',
  business_name: '',
  type: 'wholesaler',
  phone: '',
  alt_phone: '',
  city: '',
  area: '',
  address: '',
  ntn: '',
  credit_limit: '0',
  payment_terms_days: '',
  opening_balance: '0',
  opening_balance_date: '',
  notes: '',
  reason: '',
};

function fromCustomer(c: Customer): FormValues {
  return {
    name: c.name,
    business_name: c.business_name ?? '',
    type: c.type,
    phone: formatPhone(c.phone),
    alt_phone: formatPhone(c.alt_phone),
    city: c.city ?? '',
    area: c.area ?? '',
    address: c.address ?? '',
    ntn: c.ntn ?? '',
    credit_limit: paisaToInput(c.credit_limit_paisa),
    payment_terms_days: String(c.payment_terms_days),
    opening_balance: paisaToInput(c.opening_balance_paisa),
    opening_balance_date: c.opening_balance_date ?? '',
    notes: c.notes ?? '',
    reason: '',
  };
}

/**
 * Add or edit a customer. `quick` shows only name, phone, type, city and
 * terms (the "+ Add new customer" dialog on sale screens).
 */
export function CustomerFormDialog({
  customer,
  quick = false,
  initialName = '',
  onClose,
  onSaved,
}: {
  customer?: Customer;
  quick?: boolean;
  initialName?: string;
  onClose: () => void;
  onSaved?: (c: Customer) => void;
}) {
  const qc = useQueryClient();
  const settings = usePublicSettings();
  const cities = useCities();
  const form = useForm<FormValues>({ defaultValues: customer ? fromCustomer(customer) : { ...EMPTY, name: initialName } });
  const { setValue, getValues } = form;

  // Prefill terms from settings for new customers.
  useEffect(() => {
    if (!customer && settings.data && !getValues('payment_terms_days')) {
      setValue('payment_terms_days', String(settings.data.default_payment_terms_days));
    }
  }, [customer, settings.data, setValue, getValues]);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      customer
        ? api.patch<{ customer: Customer }>(`/api/customers/${customer.id}`, body)
        : api.post<{ customer: Customer }>('/api/customers', body),
    onSuccess: ({ customer: saved }) => {
      void qc.invalidateQueries({ queryKey: CUSTOMERS_KEY });
      toast.success(customer ? 'Customer saved.' : `Customer ${saved.code} added.`);
      onSaved?.(saved);
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError) applyServerFieldErrors(e.fields, form.setError);
      toast.error(errorMessage(e));
    },
  });

  const onSubmit = form.handleSubmit((v) => {
    const credit = parseRupeesToPaisa(v.credit_limit || '0');
    const opening = parseRupeesToPaisa(v.opening_balance || '0', { allowNegative: true });
    const terms = Number(v.payment_terms_days);
    let bad = false;
    if (credit === null) {
      form.setError('credit_limit', { message: 'Enter an amount like 50000' });
      bad = true;
    }
    if (opening === null) {
      form.setError('opening_balance', { message: 'Enter an amount; use minus for an advance' });
      bad = true;
    }
    if (!Number.isInteger(terms) || terms < 0) {
      form.setError('payment_terms_days', { message: 'Enter a number of days' });
      bad = true;
    }
    if (bad) return;

    const body: Record<string, unknown> = {
      name: v.name,
      type: v.type,
      phone: v.phone,
      city: v.city,
      payment_terms_days: terms,
    };
    if (!quick) {
      Object.assign(body, {
        business_name: v.business_name,
        alt_phone: v.alt_phone,
        area: v.area,
        address: v.address,
        ntn: v.ntn,
        notes: v.notes,
        credit_limit_paisa: credit,
        opening_balance_paisa: opening,
        ...(v.opening_balance_date ? { opening_balance_date: v.opening_balance_date } : {}),
      });
      if (customer && v.reason.trim()) body.reason = v.reason;
    }
    save.mutate(body);
  });

  const err = form.formState.errors;
  const reg = form.register;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={quick ? 'max-w-md' : 'max-w-3xl'}>
        <DialogHeader>
          <DialogTitle>{customer ? `Edit ${customer.code}` : quick ? 'Add new customer' : 'New customer'}</DialogTitle>
          {quick && <DialogDescription>You can add the address and other details later.</DialogDescription>}
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className={quick ? 'grid grid-cols-1 gap-4' : 'grid grid-cols-1 gap-4 md:grid-cols-3'}>
            <FormField label="Name" htmlFor="c_name" error={err.name?.message}>
              <Input id="c_name" autoFocus {...reg('name', { required: 'Enter the customer name' })} />
            </FormField>
            {!quick && (
              <FormField label="Business name" htmlFor="c_business" error={err.business_name?.message}>
                <Input id="c_business" {...reg('business_name')} />
              </FormField>
            )}
            <FormField label="Type" htmlFor="c_type">
              <NativeSelect id="c_type" {...reg('type')}>
                <option value="wholesaler">Wholesaler</option>
                <option value="retailer">Retailer</option>
              </NativeSelect>
            </FormField>
            <FormField label="Phone" htmlFor="c_phone" error={err.phone?.message}>
              <Input id="c_phone" placeholder="0300 1234567" inputMode="tel" {...reg('phone')} />
            </FormField>
            {!quick && (
              <FormField label="Other phone" htmlFor="c_alt_phone" error={err.alt_phone?.message}>
                <Input id="c_alt_phone" inputMode="tel" {...reg('alt_phone')} />
              </FormField>
            )}
            <FormField label="City" htmlFor="c_city" error={err.city?.message}>
              <Input id="c_city" list="city-options" {...reg('city')} />
            </FormField>
            {!quick && (
              <>
                <FormField label="Area / market" htmlFor="c_area">
                  <Input id="c_area" {...reg('area')} />
                </FormField>
                <FormField label="NTN" htmlFor="c_ntn">
                  <Input id="c_ntn" {...reg('ntn')} />
                </FormField>
              </>
            )}
            <FormField label="Payment terms (days)" htmlFor="c_terms" error={err.payment_terms_days?.message}>
              <Input id="c_terms" inputMode="numeric" className="amount" {...reg('payment_terms_days')} />
            </FormField>
            {!quick && (
              <>
                <FormField label="Credit limit" htmlFor="c_credit" error={err.credit_limit?.message} hint="0 means no limit.">
                  <MoneyInput id="c_credit" {...reg('credit_limit')} />
                </FormField>
                <FormField
                  label="Opening balance"
                  htmlFor="c_opening"
                  error={err.opening_balance?.message}
                  hint="What they owed before ShopLedger. Use minus (−) for an advance."
                >
                  <MoneyInput id="c_opening" {...reg('opening_balance')} />
                </FormField>
                <FormField label="Opening balance date" htmlFor="c_opening_date" error={err.opening_balance_date?.message} hint="Empty means today.">
                  <Input id="c_opening_date" type="date" {...reg('opening_balance_date')} />
                </FormField>
              </>
            )}
          </div>
          {!quick && (
            <>
              <FormField label="Address" htmlFor="c_address">
                <Input id="c_address" {...reg('address')} />
              </FormField>
              <FormField label="Notes" htmlFor="c_notes">
                <Textarea id="c_notes" rows={2} {...reg('notes')} />
              </FormField>
              {customer && (
                <FormField label="Reason for change (optional)" htmlFor="c_reason" hint="Recorded in the change history.">
                  <Input id="c_reason" {...reg('reason')} />
                </FormField>
              )}
            </>
          )}
          <datalist id="city-options">
            {cities.data?.map((c) => <option key={c} value={c} />)}
          </datalist>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {customer ? 'Save' : 'Add customer'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
