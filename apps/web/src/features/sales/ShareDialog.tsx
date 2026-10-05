import type { Sale } from '@shopledger/shared';
import { formatPaisa } from '@shopledger/shared';
import { MessageCircle, Printer, Receipt } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { errorMessage } from '@/lib/api';
import { printSale } from './api';

/** Print / PDF / WhatsApp for a saved invoice (Ctrl+Enter on the New Sale screen). */
export function ShareDialog({ sale, onClose }: { sale: Sale; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
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
    <Dialog open onOpenChange={(o) => !o && onClose()}>
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
          <Button variant="outline" disabled title="Arrives in a later update">
            <MessageCircle /> WhatsApp (coming soon)
          </Button>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
