import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createUserSchema,
  resetPasswordSchema,
  type CreateUserInput,
  type PublicUser,
  type ResetPasswordInput,
} from '@shopledger/shared';
import { KeyRound, Pencil, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { applyServerFieldErrors, FormField } from '@/components/FormField';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, NativeSelect } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useCan, useMe } from '@/features/auth/useAuth';
import { api, ApiError, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';

const USERS_KEY = ['users'] as const;
const ROLE_LABEL = { superuser: 'Superuser', owner: 'Owner', operator: 'Operator' } as const;

export function UsersPanel() {
  const can = useCan();
  const { data: me } = useMe();
  const users = useQuery({ queryKey: USERS_KEY, queryFn: () => api.get<{ users: PublicUser[] }>('/api/users') });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<PublicUser | null>(null);
  const [resetting, setResetting] = useState<PublicUser | null>(null);

  const canManage = (u: PublicUser) =>
    u.role !== 'superuser' && u.id !== me?.user.id && (u.role === 'owner' ? can('users.manage_owners') : can('users.manage_operators'));

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between">
        <div>
          <CardTitle>Users</CardTitle>
          <CardDescription>
            {can('users.manage_owners') ? 'You can manage owners and operators.' : 'You can manage operators.'} Accounts are
            deactivated, never deleted.
          </CardDescription>
        </div>
        <Button onClick={() => setAdding(true)}>
          <UserPlus /> Add user
        </Button>
      </CardHeader>
      <CardContent>
        {users.isPending && <p>Loading…</p>}
        {users.isError && <p className="text-destructive">{errorMessage(users.error)}</p>}
        {users.data && (
          <table className="w-full text-[15px]">
            <thead>
              <tr className="border-b border-border text-left text-sm text-muted-foreground">
                <th className="py-2">Name</th>
                <th>Username</th>
                <th>Role</th>
                <th>Status</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.data.users.map((u) => (
                <tr key={u.id} className="border-b border-border last:border-0">
                  <td className="py-2 font-medium">{u.display_name}</td>
                  <td>{u.username}</td>
                  <td>{ROLE_LABEL[u.role]}</td>
                  <td>{u.active ? <Badge variant="success">Active</Badge> : <Badge variant="grey">Inactive</Badge>}</td>
                  <td className="text-sm text-muted-foreground">{formatDateTime(u.created_at)}</td>
                  <td className="text-right">
                    {canManage(u) && (
                      <>
                        <Button variant="ghost" size="sm" onClick={() => setEditing(u)}>
                          <Pencil /> Edit
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setResetting(u)}>
                          <KeyRound /> Password
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
      {adding && <AddUserDialog onClose={() => setAdding(false)} canAddOwner={can('users.manage_owners')} />}
      {editing && <EditUserDialog user={editing} onClose={() => setEditing(null)} canMakeOwner={can('users.manage_owners')} />}
      {resetting && <ResetPasswordDialog user={resetting} onClose={() => setResetting(null)} />}
    </Card>
  );
}

function AddUserDialog({ onClose, canAddOwner }: { onClose: () => void; canAddOwner: boolean }) {
  const qc = useQueryClient();
  const form = useForm<CreateUserInput>({
    resolver: zodResolver(createUserSchema),
    defaultValues: { username: '', display_name: '', role: 'operator', password: '' },
  });
  const save = useMutation({
    mutationFn: (v: CreateUserInput) => api.post('/api/users', v),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: USERS_KEY });
      toast.success('User added.');
      onClose();
    },
    onError: (e) => {
      if (!(e instanceof ApiError && applyServerFieldErrors(e.fields, form.setError))) toast.error(errorMessage(e));
    },
  });
  const err = form.formState.errors;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add user</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={form.handleSubmit((v) => save.mutate(v))}>
          <FormField label="Full name" htmlFor="new_display_name" error={err.display_name?.message}>
            <Input id="new_display_name" autoFocus {...form.register('display_name')} />
          </FormField>
          <FormField label="Username" htmlFor="new_username" error={err.username?.message}>
            <Input id="new_username" autoComplete="off" {...form.register('username')} />
          </FormField>
          <FormField label="Role" htmlFor="new_role">
            <NativeSelect id="new_role" {...form.register('role')}>
              <option value="operator">Operator</option>
              {canAddOwner && <option value="owner">Owner</option>}
            </NativeSelect>
          </FormField>
          <FormField label="Password" htmlFor="new_password" error={err.password?.message} hint="At least 8 characters. Give it to the person privately.">
            <Input id="new_password" type="password" autoComplete="new-password" {...form.register('password')} />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              Add user
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditUserDialog({ user, onClose, canMakeOwner }: { user: PublicUser; onClose: () => void; canMakeOwner: boolean }) {
  const qc = useQueryClient();
  const [displayName, setDisplayName] = useState(user.display_name);
  const [role, setRole] = useState(user.role);
  const [active, setActive] = useState(user.active);
  const [reason, setReason] = useState('');
  const deactivating = user.active && !active;

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/api/users/${user.id}`, {
        ...(displayName.trim() !== user.display_name ? { display_name: displayName } : {}),
        ...(role !== user.role ? { role } : {}),
        ...(active !== user.active ? { active } : {}),
        ...(reason.trim() ? { reason } : {}),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: USERS_KEY });
      toast.success('User updated.');
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {user.username}</DialogTitle>
          <DialogDescription>A deactivated user is logged out and cannot log in.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <FormField label="Full name" htmlFor="edit_name">
            <Input id="edit_name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </FormField>
          {canMakeOwner && (
            <FormField label="Role" htmlFor="edit_role">
              <NativeSelect id="edit_role" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
                <option value="operator">Operator</option>
                <option value="owner">Owner</option>
              </NativeSelect>
            </FormField>
          )}
          <div className="flex items-center gap-3">
            <Switch id="edit_active" checked={active} onCheckedChange={setActive} />
            <label htmlFor="edit_active" className="text-sm font-semibold">
              Active
            </label>
          </div>
          {deactivating && (
            <FormField label="Reason" htmlFor="edit_reason" hint="Recorded in the change history.">
              <Input id="edit_reason" value={reason} onChange={(e) => setReason(e.target.value)} />
            </FormField>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={deactivating ? 'destructive' : 'default'} onClick={() => save.mutate()} disabled={save.isPending}>
            {deactivating ? 'Deactivate' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onClose }: { user: PublicUser; onClose: () => void }) {
  const form = useForm<ResetPasswordInput>({ resolver: zodResolver(resetPasswordSchema), defaultValues: { password: '' } });
  const save = useMutation({
    mutationFn: (v: ResetPasswordInput) => api.post(`/api/users/${user.id}/password`, v),
    onSuccess: () => {
      toast.success(`Password changed for ${user.username}. They have been logged out.`);
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New password for {user.username}</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={form.handleSubmit((v) => save.mutate(v))}>
          <FormField label="New password" htmlFor="reset_password" error={form.formState.errors.password?.message} hint="At least 8 characters.">
            <Input id="reset_password" type="password" autoFocus autoComplete="new-password" {...form.register('password')} />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              Change password
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
