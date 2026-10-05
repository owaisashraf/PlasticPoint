import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { changeOwnPasswordSchema, type ChangeOwnPasswordInput } from '@shopledger/shared';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { FormField } from '@/components/FormField';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';

export function AccountPage() {
  const form = useForm<ChangeOwnPasswordInput>({
    resolver: zodResolver(changeOwnPasswordSchema),
    defaultValues: { current_password: '', new_password: '' },
  });
  const save = useMutation({
    mutationFn: (v: ChangeOwnPasswordInput) => api.post('/api/me/password', v),
    onSuccess: () => {
      form.reset();
      toast.success('Password changed. You were logged out on other devices.');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const err = form.formState.errors;

  return (
    <div className="max-w-md">
      <PageHeader title="My account" />
      <Card>
        <CardHeader>
          <CardTitle>Change my password</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={form.handleSubmit((v) => save.mutate(v))}>
            <FormField label="Current password" htmlFor="current_password" error={err.current_password?.message}>
              <Input id="current_password" type="password" autoComplete="current-password" {...form.register('current_password')} />
            </FormField>
            <FormField label="New password" htmlFor="new_password" error={err.new_password?.message} hint="At least 8 characters.">
              <Input id="new_password" type="password" autoComplete="new-password" {...form.register('new_password')} />
            </FormField>
            <Button type="submit" disabled={save.isPending}>
              Change password
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
