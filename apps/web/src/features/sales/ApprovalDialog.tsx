import type { ApprovalInput, SaleIssue } from '@shopledger/shared';
import { ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { FormField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

/**
 * Owner approval (CLAUDE.md section 15). An owner or the superuser confirms
 * their own sale; during an operator's session the owner types their
 * username and password here. The issue messages come from the server and
 * never reveal cost or supplier margin to an operator.
 */
export function ApprovalDialog({
  issues,
  selfApprove,
  pending,
  error,
  onCancel,
  onApprove,
}: {
  issues: SaleIssue[];
  selfApprove: boolean;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onApprove: (approval: ApprovalInput) => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const needing = issues.filter((i) => i.severity === 'approval');
  // The same generic message on several lines is shown once.
  const messages = [...new Set(needing.map((i) => (i.line_index === null ? i.message : `Line ${i.line_index + 1}: ${i.message}`)))];

  const submit = () => onApprove(selfApprove ? { confirmed: true } : { username, password });

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="size-5 text-destructive" /> Owner approval needed
          </DialogTitle>
          <DialogDescription>{selfApprove ? 'Check these points, then approve to save the sale.' : 'Ask the owner to type their username and password to approve this sale.'}</DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-[15px]">
          {messages.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
        {!selfApprove && (
          <form
            className="grid grid-cols-2 gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <FormField label="Owner username" htmlFor="ap_user">
              <Input id="ap_user" autoFocus autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />
            </FormField>
            <FormField label="Owner password" htmlFor="ap_pass">
              <Input id="ap_pass" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
            </FormField>
            <button type="submit" hidden />
          </form>
        )}
        {error && <p className="font-medium text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Back to the sale
          </Button>
          <Button autoFocus={selfApprove} onClick={submit} disabled={pending || (!selfApprove && (!username.trim() || !password))}>
            {pending ? 'Saving…' : 'Approve and save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
