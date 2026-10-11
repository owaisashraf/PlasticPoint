import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatPhone, type SendResult, type WhatsAppLogEntry } from '@shopledger/shared';
import { ExternalLink, FolderOpen, MessageCircle } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useCan } from '@/features/auth/useAuth';
import { useCustomer, usePublicSettings } from '@/features/customers/api';
import { CustomerFormDialog } from '@/features/customers/CustomerFormDialog';
import { api, ApiError, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';

/** What to send on WhatsApp (CLAUDE.md 13). */
export type WhatsAppTarget =
  | { kind: 'invoice'; saleId: number; customerId: number }
  | { kind: 'statement'; customerId: number; from?: string; to?: string }
  | { kind: 'reminder'; customerId: number };

const KIND_LABEL = {
  invoice: 'Invoice',
  statement: 'Statement',
  reminder: 'Payment reminder',
} as const;

function request(t: WhatsAppTarget): Promise<SendResult> {
  if (t.kind === 'invoice') return api.post(`/api/whatsapp/invoice/${t.saleId}`);
  if (t.kind === 'statement')
    return api.post(`/api/whatsapp/statement/${t.customerId}`, {
      from: t.from,
      to: t.to,
    });
  return api.post(`/api/whatsapp/reminder/${t.customerId}`);
}

/**
 * Sends on WhatsApp. Click-to-chat opens a wa.me tab with the message and
 * offers "Open folder" so the saved PDF can be dragged into the chat; the
 * Cloud API sends directly. A missing or wrong phone number turns into a
 * prompt to correct it. Render `element` somewhere in the page.
 */
export function useWhatsApp(opts: { onDone?: () => void } = {}) {
  const qc = useQueryClient();
  const mode = usePublicSettings().data?.whatsapp_mode ?? 'click_to_chat';
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{
    r: SendResult;
    target: WhatsAppTarget;
    tabOpened: boolean;
  } | null>(null);
  const [phoneFix, setPhoneFix] = useState<{
    target: WhatsAppTarget;
    message: string;
  } | null>(null);

  const send = async (target: WhatsAppTarget) => {
    // Open the tab inside the click so the browser does not block it.
    const tab = mode === 'click_to_chat' ? window.open('', '_blank') : null;
    setBusy(true);
    try {
      const r = await request(target);
      void qc.invalidateQueries({ queryKey: ['whatsapp'] });
      setPhoneFix(null);
      if (r.url) {
        if (tab) tab.location.href = r.url;
        setSent({ r, target, tabOpened: Boolean(tab) });
      } else {
        tab?.close();
        toast.success(`${KIND_LABEL[target.kind]} sent on WhatsApp to ${formatPhone(r.phone)}.`);
        opts.onDone?.();
      }
    } catch (e) {
      tab?.close();
      if (e instanceof ApiError && (e.code === 'PHONE_MISSING' || e.code === 'PHONE_INVALID')) setPhoneFix({ target, message: e.message });
      else toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const element: ReactNode = (
    <>
      {sent && (
        <SentDialog
          sent={sent}
          onClose={() => {
            setSent(null);
            opts.onDone?.();
          }}
        />
      )}
      {phoneFix && <PhoneFixDialog fix={phoneFix} busy={busy} onSend={() => void send(phoneFix.target)} onClose={() => setPhoneFix(null)} />}
    </>
  );

  return { send, busy, element, active: sent !== null || phoneFix !== null };
}

function SentDialog({ sent: { r, target, tabOpened }, onClose }: { sent: { r: SendResult; target: WhatsAppTarget; tabOpened: boolean }; onClose: () => void }) {
  const [opening, setOpening] = useState(false);
  const openFolder = async () => {
    setOpening(true);
    try {
      await api.post(`/api/whatsapp/log/${r.log_id}/open-folder`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setOpening(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{tabOpened ? 'WhatsApp opened' : 'Open WhatsApp'}</DialogTitle>
          <DialogDescription>
            {KIND_LABEL[target.kind]} for {formatPhone(r.phone)}. Check the message in WhatsApp and press Send.
          </DialogDescription>
        </DialogHeader>
        {r.pdf_name && (
          <div className="rounded-md border border-border bg-muted/40 px-4 py-3">
            <p className="font-semibold">PDF saved: {r.pdf_name}</p>
            <p className="text-sm text-muted-foreground">Drag it from the folder into the WhatsApp chat.</p>
            <Button className="mt-2" variant="outline" onClick={() => void openFolder()} disabled={opening}>
              <FolderOpen /> Open folder
            </Button>
          </div>
        )}
        <pre className="max-h-40 overflow-auto rounded-md border border-border bg-card p-3 font-sans text-sm whitespace-pre-wrap">{r.message}</pre>
        <DialogFooter>
          <Button variant="outline" asChild>
            <a href={r.url ?? '#'} target="_blank" rel="noreferrer">
              <ExternalLink /> {tabOpened ? 'Open WhatsApp again' : 'Open WhatsApp'}
            </a>
          </Button>
          <Button autoFocus onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PhoneFixDialog({
  fix,
  busy,
  onSend,
  onClose,
}: {
  fix: { target: WhatsAppTarget; message: string };
  busy: boolean;
  onSend: () => void;
  onClose: () => void;
}) {
  const can = useCan();
  const customer = useCustomer(fix.target.customerId).data;
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  if (editing && customer) {
    return <CustomerFormDialog customer={customer} onClose={() => setEditing(false)} onSaved={() => setSaved(true)} />;
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{saved ? 'Phone number saved' : 'Phone number needed'}</DialogTitle>
          <DialogDescription>{saved ? `Send the ${KIND_LABEL[fix.target.kind].toLowerCase()} on WhatsApp now?` : fix.message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {saved ? (
            <Button autoFocus onClick={onSend} disabled={busy}>
              <MessageCircle /> Send on WhatsApp
            </Button>
          ) : (
            can('customers.manage') && (
              <Button autoFocus onClick={() => setEditing(true)} disabled={!customer}>
                Edit phone number
              </Button>
            )
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Most recent successful sends of an invoice or to a customer. */
export function useWhatsAppHistory(q: { sale_id?: number; customer_id?: number }, enabled = true) {
  const key = q.sale_id ? `sale_id=${q.sale_id}` : `customer_id=${q.customer_id ?? 0}`;
  return useQuery({
    queryKey: ['whatsapp', 'history', key],
    queryFn: () => api.get<{ entries: WhatsAppLogEntry[] }>(`/api/whatsapp/history?${key}`).then((r) => r.entries),
    enabled,
  });
}

/** "Sent on WhatsApp at 10 Oct 2026, 11:00 by Ali" for the latest send, if any. */
export function LastSent({ entries, kind }: { entries: WhatsAppLogEntry[] | undefined; kind?: WhatsAppLogEntry['kind'] }) {
  const last = entries?.find((e) => e.status !== 'failed' && (!kind || e.kind === kind));
  if (!last) return null;
  return (
    <span className="inline-flex items-center gap-1 text-sm text-emerald-700" data-testid="whatsapp-last-sent">
      <MessageCircle className="size-4" /> Sent on WhatsApp at {formatDateTime(last.at)}
      {last.user_name ? ` by ${last.user_name}` : ''}
    </span>
  );
}
