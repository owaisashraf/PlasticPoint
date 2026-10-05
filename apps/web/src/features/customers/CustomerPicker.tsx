import { Command } from 'cmdk';
import { formatPhone, type Customer } from '@shopledger/shared';
import { Plus, Search } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { Balance, CustomerStatusBadge } from '@/components/badges';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useCan } from '@/features/auth/useAuth';
import { useCustomers } from './api';
import { CustomerFormDialog } from './CustomerFormDialog';

/**
 * Quick customer search (F2). Searches name, business name, phone, city and
 * code as you type, including parts of words. The last option is always
 * "+ Add new customer"; the new customer is then selected.
 * The overdue badge arrives in phase 6.
 */
export function CustomerPicker({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSelect: (c: Customer) => void;
}) {
  const can = useCan();
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const deferred = useDeferredValue(q.trim());
  const { data, isFetching } = useCustomers({ q: deferred, limit: 20 }, open);
  const results = (data?.customers ?? []).filter((c) => c.status !== 'inactive');

  const choose = (c: Customer) => {
    onSelect(c);
    onOpenChange(false);
    setQ('');
  };

  return (
    <>
      <Dialog open={open && !adding} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl gap-0 p-0" aria-describedby={undefined}>
          <DialogTitle className="sr-only">Find customer</DialogTitle>
          <Command shouldFilter={false} loop className="flex flex-col">
            <div className="flex items-center gap-2 border-b border-border px-4">
              <Search className="size-5 text-muted-foreground" />
              <Command.Input
                autoFocus
                value={q}
                onValueChange={setQ}
                placeholder="Name, shop, phone, city or code…"
                className="h-12 flex-1 bg-transparent text-base outline-none"
              />
              {isFetching && <span className="text-xs text-muted-foreground">Searching…</span>}
            </div>
            <Command.List className="max-h-[60vh] overflow-y-auto p-2">
              {deferred && results.length === 0 && !isFetching && (
                <div className="px-3 py-4 text-sm text-muted-foreground">No customer matches “{deferred}”.</div>
              )}
              {results.map((c) => (
                <Command.Item
                  key={c.id}
                  value={String(c.id)}
                  onSelect={() => choose(c)}
                  className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 data-[selected=true]:bg-primary data-[selected=true]:text-primary-foreground"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 font-semibold">
                      <span className="truncate">{c.name}</span>
                      <CustomerStatusBadge status={c.status} />
                    </div>
                    <div className="truncate text-sm opacity-80">
                      {[c.code, c.business_name, c.city, formatPhone(c.phone)].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <div className="text-right text-sm">
                    <Balance paisa={c.balance_paisa} className="block" />
                    <span className="opacity-80">{c.payment_terms_days} days</span>
                  </div>
                </Command.Item>
              ))}
              {can('customers.manage') && (
                <Command.Item
                  value="__add__"
                  onSelect={() => setAdding(true)}
                  className="mt-1 flex cursor-pointer items-center gap-2 rounded-md border-t border-border px-3 py-2.5 font-semibold text-primary data-[selected=true]:bg-primary data-[selected=true]:text-primary-foreground"
                >
                  <Plus className="size-4" /> Add new customer{deferred ? ` “${deferred}”` : ''}
                </Command.Item>
              )}
            </Command.List>
          </Command>
        </DialogContent>
      </Dialog>
      {adding && (
        <CustomerFormDialog
          quick
          initialName={/\d/.test(deferred) ? '' : deferred}
          onClose={() => setAdding(false)}
          onSaved={(c) => {
            setAdding(false);
            choose(c);
          }}
        />
      )}
    </>
  );
}
