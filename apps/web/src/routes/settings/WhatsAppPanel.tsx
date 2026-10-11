import { useMutation, useQueryClient } from '@tanstack/react-query';
import { WHATSAPP_PLACEHOLDERS, type CloudApiCheck } from '@shopledger/shared';
import { KeyRound, PlugZap } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { FormField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';

/**
 * The Cloud API access token (write-only: the server never sends it back),
 * a connection test, and the list of message placeholders.
 */
export function WhatsAppPanel({ tokenSet }: { tokenSet: boolean }) {
  const qc = useQueryClient();
  const [token, setToken] = useState('');
  const saveToken = useMutation({
    mutationFn: (value: string) => api.patch('/api/settings', { changes: { whatsapp_cloud_token: value } }),
    onSuccess: (_r, value) => {
      setToken('');
      void qc.invalidateQueries({ queryKey: ['settings'] });
      toast.success(value ? 'Access token saved.' : 'Access token removed.');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const test = useMutation({
    mutationFn: () => api.post<CloudApiCheck>('/api/whatsapp/test'),
    onSuccess: (r) => toast.success(`Connected: ${[r.verified_name, r.display_phone_number].filter(Boolean).join(' · ') || 'WhatsApp Business number'}`),
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <>
      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Cloud API access token</CardTitle>
          <CardDescription>
            Only needed for the Cloud API. Save the phone number ID, the token and the invoice template first, test the connection, then switch “How to send” to
            the Cloud API. The token is kept on this laptop and is never shown again.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <FormField label={tokenSet ? 'Replace the token' : 'Access token'} htmlFor="wa-token" hint={tokenSet ? 'A token is saved.' : 'No token saved.'}>
            <Input id="wa-token" type="password" autoComplete="off" className="w-96" value={token} onChange={(e) => setToken(e.target.value)} />
          </FormField>
          <Button onClick={() => saveToken.mutate(token.trim())} disabled={!token.trim() || saveToken.isPending}>
            <KeyRound /> Save token
          </Button>
          {tokenSet && (
            <Button variant="ghost" onClick={() => saveToken.mutate('')} disabled={saveToken.isPending}>
              Remove token
            </Button>
          )}
          <Button variant="outline" onClick={() => test.mutate()} disabled={!tokenSet || test.isPending}>
            <PlugZap /> {test.isPending ? 'Testing…' : 'Test connection'}
          </Button>
        </CardContent>
      </Card>
      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Placeholders</CardTitle>
          <CardDescription>Type these in a message (with the curly brackets) and they are filled in when it is sent.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {WHATSAPP_PLACEHOLDERS.map((p) => (
            <code key={p} className="rounded bg-muted px-2 py-1 text-sm">{`{${p}}`}</code>
          ))}
        </CardContent>
      </Card>
    </>
  );
}
