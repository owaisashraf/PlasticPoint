import { useMutation } from '@tanstack/react-query';
import { KeyRound, LogOut } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useCan, useClearSession, useMe } from '@/features/auth/useAuth';
import { useOverdueCount } from '@/features/overdue';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { BackupFooter } from './BackupFooter';
import { NAV_ITEMS } from './nav';
import { ShortcutsDialog } from './ShortcutsDialog';
import { Button } from './ui/button';

const ROLE_LABEL = { superuser: 'Superuser', owner: 'Owner', operator: 'Operator' } as const;

function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

export function AppShell() {
  const { data: me } = useMe();
  const can = useCan();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const clearSession = useClearSession();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const overdueCount = useOverdueCount(can('overdue.view')).data ?? 0;

  const logout = useMutation({
    mutationFn: () => api.post('/api/auth/logout'),
    onSuccess: () => {
      clearSession();
      navigate('/login', { replace: true });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  // Global shortcuts (CLAUDE.md section 15). Screen-specific ones (F2, F3,
  // Ctrl+S) are handled by the screens that use them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F4') {
        e.preventDefault();
        if (can('sales.create')) navigate('/sales/new');
      } else if (e.key === '?' && !isTyping(e)) {
        e.preventDefault();
        setShortcutsOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [can, navigate]);

  if (!me) return null;
  const items = NAV_ITEMS.filter((i) => can(i.permission));

  return (
    <div className="flex h-screen flex-col">
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <div className="text-lg font-extrabold text-primary">ShopLedger</div>
          </div>
          <nav className="flex-1 overflow-y-auto p-2">
            {items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) => {
                  // "Sales" stays lit on an invoice (/sales/12) but not on New Sale (/sales/new).
                  const lit = isActive && !(item.to === '/sales' && pathname === '/sales/new');
                  return cn('flex items-center gap-2.5 rounded-md px-3 py-2 text-[15px] font-medium hover:bg-muted', lit && 'bg-primary text-primary-foreground hover:bg-primary');
                }}
              >
                <item.icon className="size-4 shrink-0" />
                <span className="flex-1">{item.label}</span>
                {item.countBadge === 'overdue' && overdueCount > 0 && (
                  <span className="rounded-full bg-red-600 px-2 text-xs font-bold text-white" aria-label={`${overdueCount} overdue customers`}>
                    {overdueCount}
                  </span>
                )}
                {item.shortcut && <kbd className="text-xs opacity-70">{item.shortcut}</kbd>}
              </NavLink>
            ))}
          </nav>
          <div className="border-t border-border p-3 text-sm">
            <div className="font-semibold">{me.user.display_name}</div>
            <div className="text-muted-foreground">
              {me.user.username} · {ROLE_LABEL[me.user.role]}
            </div>
            <div className="mt-2 flex gap-1">
              <Button variant="ghost" size="sm" onClick={() => navigate('/account')} title="Change my password">
                <KeyRound /> Account
              </Button>
              <Button variant="ghost" size="sm" onClick={() => logout.mutate()} disabled={logout.isPending}>
                <LogOut /> Log out
              </Button>
            </div>
          </div>
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
      <footer className="flex items-center justify-between border-t border-border bg-card px-4 py-1.5 text-sm">
        <BackupFooter />
        <button className="cursor-pointer text-muted-foreground hover:text-foreground" onClick={() => setShortcutsOpen(true)}>
          Press <kbd className="rounded border border-border px-1">?</kbd> for keyboard shortcuts
        </button>
      </footer>
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}
