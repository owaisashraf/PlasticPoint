import { HandCoins, Landmark } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useCan } from '@/features/auth/useAuth';
import { PaymentsTable } from '@/features/payments/PaymentsTable';
import { PaySupplierDialog } from '@/features/payments/PaySupplierDialog';
import { ReceivePaymentDialog } from '@/features/payments/ReceivePaymentDialog';
import { useSuppliers } from '@/features/purchases/api';
import { useHotkey } from '@/lib/useHotkey';

export function PaymentsPage() {
  const can = useCan();
  const suppliers = useSuppliers();
  const [dialog, setDialog] = useState<'receive' | 'supplier' | null>(null);
  useHotkey('F2', () => can('payments.create') && !dialog && setDialog('receive'));

  return (
    <div>
      <PageHeader
        title="Payments"
        actions={
          can('payments.create') && (
            <>
              <Button variant="outline" onClick={() => setDialog('supplier')} disabled={!suppliers.data?.length}>
                <Landmark /> Pay supplier
              </Button>
              <Button onClick={() => setDialog('receive')} title="F2">
                <HandCoins /> Receive payment <kbd className="text-xs opacity-70">F2</kbd>
              </Button>
            </>
          )
        }
      />
      <Tabs defaultValue="receipts">
        <TabsList>
          <TabsTrigger value="receipts">Received from customers</TabsTrigger>
          <TabsTrigger value="supplier">Paid to supplier</TabsTrigger>
          <TabsTrigger value="refunds">Refunds</TabsTrigger>
        </TabsList>
        <TabsContent value="receipts">
          <PaymentsTable kind="receipt" />
        </TabsContent>
        <TabsContent value="supplier">
          <PaymentsTable kind="supplier_payment" />
        </TabsContent>
        <TabsContent value="refunds">
          <PaymentsTable kind="refund" />
        </TabsContent>
      </Tabs>
      {dialog === 'receive' && <ReceivePaymentDialog onClose={() => setDialog(null)} />}
      {dialog === 'supplier' && suppliers.data && <PaySupplierDialog suppliers={suppliers.data} onClose={() => setDialog(null)} />}
    </div>
  );
}
