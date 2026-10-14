import { formatPhone } from '@shopledger/shared';
import { CalendarDays, Search, UserPlus } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { useNavigate } from 'react-router';
import { Balance, CustomerStatusBadge } from '@/components/badges';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/input';
import { useCan } from '@/features/auth/useAuth';
import { useCities, useCustomers } from '@/features/customers/api';
import { CustomerFormDialog } from '@/features/customers/CustomerFormDialog';
import { CustomerPicker } from '@/features/customers/CustomerPicker';
import { OverdueBadge } from '@/features/overdue';
import { errorMessage } from '@/lib/api';
import { useHotkey } from '@/lib/useHotkey';

const PAGE = 100;

export function CustomersPage() {
  const can = useCan();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [city, setCity] = useState('');
  const [status, setStatus] = useState('active');
  const [limit, setLimit] = useState(PAGE);
  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState(false);
  const deferredQ = useDeferredValue(q.trim());
  const cities = useCities();
  const list = useCustomers({ q: deferredQ, type, city, status, limit });

  useHotkey('F2', () => setPicking(true));

  return (
    <div>
      <PageHeader
        title="Customers"
        actions={
          <>
            {can('reports.operational') && (
              <Button variant="outline" onClick={() => navigate('/reports/balances')}>
                <CalendarDays /> Balances on a date
              </Button>
            )}
            <Button variant="outline" onClick={() => setPicking(true)} title="F2">
              <Search /> Find <kbd className="text-xs opacity-70">F2</kbd>
            </Button>
            {can('customers.manage') && (
              <Button onClick={() => setAdding(true)}>
                <UserPlus /> New customer
              </Button>
            )}
          </>
        }
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <Input className="w-72" placeholder="Search name, shop, phone, city, code" value={q} onChange={(e) => setQ(e.target.value)} />
        <NativeSelect className="w-40" value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">
          <option value="">All types</option>
          <option value="wholesaler">Wholesalers</option>
          <option value="retailer">Retailers</option>
        </NativeSelect>
        <NativeSelect className="w-44" value={city} onChange={(e) => setCity(e.target.value)} aria-label="City">
          <option value="">All cities</option>
          {cities.data?.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect className="w-40" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="active">Active</option>
          <option value="bad_debt">Bad debt</option>
          <option value="inactive">Inactive</option>
          <option value="all">All</option>
        </NativeSelect>
      </div>

      {list.isError && <p className="text-destructive">{errorMessage(list.error)}</p>}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-[15px]">
          <thead className="bg-muted text-left text-sm text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Code</th>
              <th className="px-3 py-2">Customer</th>
              <th className="px-3 py-2">City</th>
              <th className="px-3 py-2">Phone</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2 text-right">Terms</th>
              <th className="px-3 py-2 text-right">Credit limit</th>
              <th className="px-3 py-2 text-right">Balance</th>
              <th className="px-3 py-2">Overdue</th>
              <th className="px-3 py-2">Last sale</th>
              <th className="px-3 py-2">Last payment</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.customers.map((c) => (
              <tr
                key={c.id}
                className="cursor-pointer border-t border-border hover:bg-muted/60"
                onClick={() => navigate(`/customers/${c.id}`)}
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && navigate(`/customers/${c.id}`)}
              >
                <td className="px-3 py-2 font-mono text-sm">{c.code}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2 font-semibold">
                    {c.name} <CustomerStatusBadge status={c.status} />
                  </div>
                  {c.business_name && <div className="text-sm text-muted-foreground">{c.business_name}</div>}
                </td>
                <td className="px-3 py-2">{c.city}</td>
                <td className="px-3 py-2 whitespace-nowrap">{formatPhone(c.phone)}</td>
                <td className="px-3 py-2 capitalize">{c.type}</td>
                <td className="amount px-3 py-2">{c.payment_terms_days} d</td>
                <td className="amount px-3 py-2">{c.credit_limit_paisa ? <Balance paisa={c.credit_limit_paisa} /> : '—'}</td>
                <td className="px-3 py-2 text-right">
                  <Balance paisa={c.balance_paisa} />
                </td>
                <td className="px-3 py-2">
                  <OverdueBadge paisa={c.overdue_paisa} days={c.overdue_days} />
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-sm">{c.last_sale_date ?? '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap text-sm">{c.last_payment_date ?? '—'}</td>
              </tr>
            ))}
            {list.data && list.data.customers.length === 0 && (
              <tr>
                <td colSpan={11} className="px-3 py-8 text-center text-muted-foreground">
                  No customers found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {list.data && (
        <div className="mt-3 flex items-center gap-3 text-sm text-muted-foreground">
          Showing {list.data.customers.length} of {list.data.total}.
          {list.data.total > list.data.customers.length && (
            <Button variant="outline" size="sm" onClick={() => setLimit((l) => l + PAGE)}>
              Show more
            </Button>
          )}
        </div>
      )}

      {adding && <CustomerFormDialog onClose={() => setAdding(false)} onSaved={(c) => navigate(`/customers/${c.id}`)} />}
      <CustomerPicker open={picking} onOpenChange={setPicking} onSelect={(c) => navigate(`/customers/${c.id}`)} />
    </div>
  );
}
