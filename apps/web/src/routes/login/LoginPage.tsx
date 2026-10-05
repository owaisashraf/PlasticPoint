import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { loginSchema, type LoginInput } from '@shopledger/shared';
import { useForm } from 'react-hook-form';
import { useLocation, useNavigate } from 'react-router';
import { FormField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useRefreshAuth } from '@/features/auth/useAuth';
import { api, errorMessage } from '@/lib/api';

export function LoginPage() {
  const refresh = useRefreshAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  const form = useForm<LoginInput>({ resolver: zodResolver(loginSchema), defaultValues: { username: '', password: '' } });
  const login = useMutation({
    mutationFn: (v: LoginInput) => api.post('/api/auth/login', v),
    onSuccess: async () => {
      await refresh();
      navigate(from === '/login' ? '/' : from, { replace: true });
    },
    onError: () => form.setValue('password', ''),
  });

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl text-primary">ShopLedger</CardTitle>
          <CardDescription>Log in to continue.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={form.handleSubmit((v) => login.mutate(v))}>
            <FormField label="Username" htmlFor="username" error={form.formState.errors.username?.message}>
              <Input id="username" autoFocus autoComplete="username" {...form.register('username')} />
            </FormField>
            <FormField label="Password" htmlFor="password" error={form.formState.errors.password?.message}>
              <Input id="password" type="password" autoComplete="current-password" {...form.register('password')} />
            </FormField>
            {login.isError && <p className="text-sm font-medium text-destructive">{errorMessage(login.error)}</p>}
            <Button type="submit" size="lg" disabled={login.isPending}>
              {login.isPending ? 'Logging in…' : 'Log in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
