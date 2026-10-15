import { formatPaisa, type Sale } from '@shopledger/shared';
import { MessageCircle, Printer, Receipt } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useCan } from '@/features/auth/useAuth';
import { LastSent, useWhatsApp, useWhatsAppHistory } from '@/features/whatsapp/WhatsApp';
import { errorMessage } from '@/lib/api';
import { printSale } from './api';

/** Print / PDF / WhatsApp for a saved invoice (Ctrl+Enter on the New Sale screen). */
export function ShareDialog({ sale, onClose }: { sale: Sale; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const can = useCan();
  const canShare = can('whatsapp.send') && sale.status === 'posted';
  const wa = useWhatsApp({ onDone: onClose });
  const history = useWhatsAppHistory({ sale_id: sale.id }, canShare);
  const print = async (size: 'A4' | '80mm') => {
    setBusy(true);
    try {
      await printSale(sale.id, size);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {wa.element}
      <Dialog open={!wa.active} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Share invoice {sale.doc_no}</DialogTitle>
            <DialogDescription>
              {sale.customer_name} · {formatPaisa(sale.total_paisa)}. The PDF opens in a new tab; print it from there.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Button autoFocus onClick={() => void print('A4')} disabled={busy}>
              <Printer /> Print / PDF (A4)
            </Button>
            <Button variant="outline" onClick={() => void print('80mm')} disabled={busy}>
              <Receipt /> Print receipt (80 mm)
            </Button>
            {canShare && (
              <Button variant="outline" onClick={() => void wa.send({ kind: 'invoice', saleId: sale.id, customerId: sale.customer_id })} disabled={wa.busy}>
                <MessageCircle /> {wa.busy ? 'Preparing…' : 'Send on WhatsApp'}
              </Button>
            )}
            <LastSent entries={history.data} />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
