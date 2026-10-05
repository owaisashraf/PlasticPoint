import { formatPaisa, type Sale } from '@shopledger/shared';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useCan } from '@/features/auth/useAuth';
import { usePurchaseReturns } from '@/features/payments/api';
import { SalesReturnsTable } from '@/features/payments/SalesReturnsTable';
import { api, errorMessage } from '@/lib/api';

/** Returns start from the original document (CLAUDE.md 10.7). */
export function ReturnsPage() {
  const can = useCan();
  const navigate = useNavigate();
  const [invoice, setInvoice] = useState('');

  const startFromInvoice = async () => {
    const q = invoice.trim().toUpperCase();
    if (!q) return;
    try {
      const { sales } = await api.get<{ sales: Sale[] }>(`/api/sales?q=${encodeURIComponent(q)}&status=posted&limit=5`);
      const found = sales.find((s) => s.doc_no === q || s.doc_no.endsWith(`-${q.padStart(6, '0')}`)) ?? (sales.length === 1 ? sales[0] : undefined);
      if (!found) return toast.error(`No invoice ${q} found. Type the full number, e.g. INV-000123.`);
      navigate(`/sales/${found.id}?return=1`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div>
      <PageHeader
        title="Returns"
        actions={
          can('returns.create') && (
            <Input
              className="w-72 font-mono uppercase placeholder:font-sans placeholder:normal-case"
              placeholder="Return from invoice no., then Enter"
              value={invoice}
              onChange={(e) => setInvoice(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void startFromInvoice()}
              aria-label="Return from invoice number"
            />
          )
        }
      />
      <Tabs defaultValue="sales">
        <TabsList>
          <TabsTrigger value="sales">From customers</TabsTrigger>
          <TabsTrigger value="purchase">To supplier</TabsTrigger>
        </TabsList>
        <TabsContent value="sales">
          <SalesReturnsTable />
        </TabsContent>
        <TabsContent value="purchase">
          <PurchaseReturnsTable />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PurchaseReturnsTable() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const list = usePurchaseReturns({ q: q.trim() });
  const rows = list.data?.returns ?? [];
  const showCost = rows.some((r) => r.total_cost_paisa !== undefined);
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <Input className="w-72" placeholder="Return or purchase no., bill no." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search purchase returns" />
        <span className="text-sm text-muted-foreground">To send goods back, open the purchase and press “Return items”.</span>
      </div>
      {list.isError && <p className="text-destructive">{errorMessage(list.error)}</p>}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-[15px]">
          <thead className="bg-muted text-left text-sm text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Return</th>
              <th className="px-3 py-2">Purchase</th>
              <th className="px-3 py-2">Supplier</th>
              <th className="px-3 py-2">Reason</th>
              <th className="px-3 py-2 text-right">Qty</th>
              {showCost && <th className="px-3 py-2 text-right">Cost</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="cursor-pointer border-t border-border hover:bg-muted/60" tabIndex={0} onClick={() => navigate(`/purchases/${r.purchase_id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/purchases/${r.purchase_id}`)}>
                <td className="px-3 py-2 whitespace-nowrap">{r.date}</td>
                <td className="px-3 py-2 font-mono font-semibold">
                  {r.doc_no} {r.status === 'void' && <Badge variant="grey">VOID</Badge>}
                </td>
                <td className="px-3 py-2 font-mono">{r.purchase_doc_no}</td>
                <td className="px-3 py-2">{r.supplier_name}</td>
                <td className="px-3 py-2">{r.reason}</td>
                <td className="amount px-3 py-2">{r.total_qty}</td>
                {showCost && <td className="amount px-3 py-2">{formatPaisa(r.total_cost_paisa ?? 0)}</td>}
              </tr>
            ))}
            {list.data && rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                  No returns to the supplier.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
