import { useMutation } from '@tanstack/react-query';
import { Ban } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { FormField } from '@/components/FormField';
import { ReasonDialog } from '@/components/ReasonDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useCan, useMe } from '@/features/auth/useAuth';
import { useRefreshAfterMoney } from '@/features/payments/api';
import { api, errorMessage } from '@/lib/api';
import { todayKarachi } from '@/lib/utils';

/**
 * Who may change a document (CLAUDE.md 8.6). Mirrors the server, which
 * always checks again: operators edit their own documents on the day they
 * entered them; the owner and superuser edit or void anything.
 */
export function useDocRights(doc: { status: string; created_by_id: number | null; created_at: string } | undefined) {
  const can = useCan();
  const me = useMe().data;
  if (!doc || doc.status !== 'posted') return { canEdit: false, canVoid: false };
  const enteredToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date(doc.created_at)) === todayKarachi();
  const ownToday = !!me && doc.created_by_id === me.user.id && enteredToday;
  return {
    canEdit: can('documents.edit_any') || (can('documents.edit_own_same_day') && ownToday),
    canVoid: can('documents.edit_any'),
  };
}

/** "Void" with a required reason. The document stays on record with a VOID stamp. */
export function VoidButton({
  url,
  docNo,
  description,
  size = 'default',
  onDone,
}: {
  url: string;
  docNo: string;
  /** What else happens, e.g. "Its counter cash receipt is voided too." */
  description?: string;
  size?: 'default' | 'sm';
  onDone?: () => void;
}) {
  const refresh = useRefreshAfterMoney();
  const [open, setOpen] = useState(false);
  const run = useMutation({
    mutationFn: (reason: string) => api.post(url, { reason }),
    onSuccess: () => {
      refresh();
      setOpen(false);
      toast.success(`${docNo} voided.`);
      onDone?.();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <>
      <Button variant="outline" size={size} className="text-destructive" onClick={() => setOpen(true)}>
        <Ban /> Void
      </Button>
      {open && (
        <ReasonDialog
          title={`Void ${docNo}?`}
          description={`It stays on record with a VOID stamp and stops counting in balances and stock.${description ? ` ${description}` : ''}`}
          confirmLabel="Void"
          destructive
          pending={run.isPending}
          onConfirm={(reason) => run.mutate(reason)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** Required "why was this changed" field for edit screens. */
export function ChangeReasonField({ value, onChange, id = 'change_reason' }: { value: string; onChange: (v: string) => void; id?: string }) {
  return (
    <FormField label="Reason for the change" htmlFor={id} hint="Required. Recorded in the change history.">
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder="e.g. Customer took fewer" />
    </FormField>
  );
}

export const changeReasonOk = (r: string) => r.trim().length >= 3;
