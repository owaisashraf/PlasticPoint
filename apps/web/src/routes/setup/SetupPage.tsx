import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { setupAccountSchema, type SetupAccountInput } from '@shopledger/shared';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { applyServerFieldErrors, FormField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useRefreshAuth, useSetupStatus } from '@/features/auth/useAuth';
import { api, ApiError, errorMessage } from '@/lib/api';

const STEPS = {
  superuser: {
    step: 1,
    title: 'Create the superuser',
    text: 'The superuser has every permission, including the change history. There is only one. Keep this password safe: it can only be reset on this laptop.',
    url: '/api/setup/superuser',
  },
  owner: {
    step: 2,
    title: 'Create the owner account',
    text: 'The shop owner sees profit, expenses and assets, and manages operators.',
    url: '/api/setup/owner',
  },
} as const;

type FormValues = SetupAccountInput & { confirm: string };

export function SetupPage() {
  const { data } = useSetupStatus();
  const refresh = useRefreshAuth();
  const navigate = useNavigate();
  const needs = data?.needs ?? 'superuser';
  const step = STEPS[needs];

  const form = useForm<FormValues>({
    resolver: zodResolver(
      setupAccountSchema.extend({ confirm: setupAccountSchema.shape.password }).refine((v) => v.password === v.confirm, {
        message: 'The passwords do not match',
        path: ['confirm'],
      }),
    ),
    defaultValues: { username: '', display_name: '', password: '', confirm: '' },
  });

  const save = useMutation({
    mutationFn: ({ confirm: _c, ...v }: FormValues) => api.post(step.url, v),
    onSuccess: async () => {
      form.reset();
      await refresh();
      if (needs === 'owner') {
        toast.success('Setup complete. You can add operators in Settings → Users.');
        navigate('/', { replace: true });
      }
    },
    onError: (e) => {
      if (!(e instanceof ApiError && applyServerFieldErrors(e.fields, form.setError))) toast.error(errorMessage(e));
    },
  });

  const err = form.formState.errors;
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <p className="text-sm font-semibold text-muted-foreground">First-time setup · Step {step.step} of 2</p>
          <CardTitle>{step.title}</CardTitle>
          <CardDescription>{step.text}</CardDescription>
        </CardHeader>
        <CardContent>
          <form key={needs} className="flex flex-col gap-4" onSubmit={form.handleSubmit((v) => save.mutate(v))}>
            <FormField label="Full name" htmlFor="display_name" error={err.display_name?.message}>
              <Input id="display_name" autoFocus {...form.register('display_name')} />
            </FormField>
            <FormField label="Username" htmlFor="username" error={err.username?.message} hint="Letters and numbers, used to log in.">
              <Input id="username" autoComplete="off" {...form.register('username')} />
            </FormField>
            <FormField label="Password" htmlFor="password" error={err.password?.message} hint="At least 8 characters.">
              <Input id="password" type="password" autoComplete="new-password" {...form.register('password')} />
            </FormField>
            <FormField label="Type the password again" htmlFor="confirm" error={err.confirm?.message}>
              <Input id="confirm" type="password" autoComplete="new-password" {...form.register('confirm')} />
            </FormField>
            <Button type="submit" size="lg" disabled={save.isPending}>
              {needs === 'superuser' ? 'Create superuser and continue' : 'Create owner and finish'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
