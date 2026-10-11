import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ExpenseCategory } from '@shopledger/shared';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { EXPENSES_KEY, useExpenseCategories } from '@/features/expenses/api';
import { api, errorMessage } from '@/lib/api';

/**
 * Expense categories (CLAUDE.md 8.12): add, rename, deactivate. A category
 * that has expenses cannot be deleted — deactivate it instead.
 */
export function ExpenseCategoriesPanel() {
  const qc = useQueryClient();
  const categories = useExpenseCategories();
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: EXPENSES_KEY });

  const run = useMutation({
    mutationFn: (a: { kind: 'add' } | { kind: 'rename'; id: number; name: string } | { kind: 'active'; id: number; active: boolean } | { kind: 'delete'; id: number }) => {
      if (a.kind === 'add') return api.post('/api/expense-categories', { name });
      if (a.kind === 'rename') return api.patch(`/api/expense-categories/${a.id}`, { name: a.name });
      if (a.kind === 'active') return api.patch(`/api/expense-categories/${a.id}`, { active: a.active });
      return api.delete(`/api/expense-categories/${a.id}`);
    },
    onSuccess: (_r, a) => {
      refresh();
      if (a.kind === 'add') setName('');
      if (a.kind === 'rename') setRenaming(null);
      toast.success(a.kind === 'add' ? 'Category added.' : a.kind === 'delete' ? 'Category deleted.' : 'Category updated.');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const row = (c: ExpenseCategory) => (
    <tr key={c.id} className="border-t border-border">
      <td className="py-2">
        {renaming?.id === c.id ? (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              run.mutate({ kind: 'rename', id: c.id, name: renaming.name });
            }}
          >
            <Input autoFocus className="h-8 w-64" value={renaming.name} onChange={(e) => setRenaming({ id: c.id, name: e.target.value })} aria-label="New name" />
            <Button size="sm" type="submit">
              Save
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
          </form>
        ) : (
          <span className={c.active ? '' : 'text-muted-foreground'}>
            {c.name} {!c.active && <Badge variant="grey">Not in use</Badge>}
          </span>
        )}
      </td>
      <td className="text-right text-sm text-muted-foreground">{c.expense_count ? `${c.expense_count} expense${c.expense_count === 1 ? '' : 's'}` : 'unused'}</td>
      <td className="text-right whitespace-nowrap">
        <Button variant="ghost" size="sm" onClick={() => setRenaming({ id: c.id, name: c.name })}>
          Rename
        </Button>
        <Button variant="ghost" size="sm" onClick={() => run.mutate({ kind: 'active', id: c.id, active: !c.active })}>
          {c.active ? 'Deactivate' : 'Activate'}
        </Button>
        {c.expense_count === 0 && (
          <Button variant="ghost" size="sm" className="text-destructive" onClick={() => run.mutate({ kind: 'delete', id: c.id })}>
            Delete
          </Button>
        )}
      </td>
    </tr>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Expense categories</CardTitle>
        <CardDescription>Categories with expenses cannot be deleted; deactivate them instead and they stay on old expenses.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="mb-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim().length >= 2) run.mutate({ kind: 'add' });
          }}
        >
          <Input className="w-72" placeholder="New category, e.g. Tea & refreshments" value={name} onChange={(e) => setName(e.target.value)} aria-label="New category name" />
          <Button type="submit" disabled={name.trim().length < 2 || run.isPending}>
            <Plus /> Add
          </Button>
        </form>
        {categories.isError && <p className="text-destructive">{errorMessage(categories.error)}</p>}
        <table className="w-full text-[15px]">
          <tbody>{(categories.data ?? []).map(row)}</tbody>
        </table>
      </CardContent>
    </Card>
  );
}
