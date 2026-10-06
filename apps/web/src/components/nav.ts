import {
  AlarmClock,
  ArrowLeftRight,
  ChartColumn,
  FileText,
  History,
  LayoutDashboard,
  Package,
  ReceiptText,
  Settings,
  ShoppingCart,
  Truck,
  Users,
  Wallet,
  Warehouse,
  type LucideIcon,
} from 'lucide-react';
import type { PermissionKey } from '@shopledger/shared';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Menu is hidden (and the page refused) without this key. */
  permission: PermissionKey;
  /** Which build phase adds the screen. */
  phase: number;
  shortcut?: string;
  /** Shows a red count (the Overdue menu). */
  countBadge?: 'overdue';
}

/** Navigation from CLAUDE.md section 10, in order. */
export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, permission: 'dashboard.view', phase: 9 },
  { to: '/sales/new', label: 'New Sale', icon: ShoppingCart, permission: 'sales.create', phase: 4, shortcut: 'F4' },
  { to: '/sales', label: 'Sales', icon: ReceiptText, permission: 'sales.view', phase: 4 },
  { to: '/purchases', label: 'Purchases', icon: Truck, permission: 'purchases.view', phase: 3 },
  { to: '/payments', label: 'Payments', icon: Wallet, permission: 'payments.view', phase: 5 },
  { to: '/returns', label: 'Returns', icon: ArrowLeftRight, permission: 'returns.view', phase: 5 },
  { to: '/customers', label: 'Customers', icon: Users, permission: 'customers.view', phase: 2 },
  { to: '/overdue', label: 'Overdue', icon: AlarmClock, permission: 'overdue.view', phase: 6, countBadge: 'overdue' },
  { to: '/products', label: 'Products & Stock', icon: Package, permission: 'products.view', phase: 2 },
  { to: '/reports', label: 'Reports', icon: ChartColumn, permission: 'reports.operational', phase: 9 },
  { to: '/expenses', label: 'Expenses', icon: FileText, permission: 'expenses.manage', phase: 8 },
  { to: '/assets', label: 'Assets', icon: Warehouse, permission: 'assets.manage', phase: 8 },
  { to: '/settings', label: 'Settings', icon: Settings, permission: 'settings.manage', phase: 1 },
  { to: '/change-history', label: 'Change History', icon: History, permission: 'changelog.view', phase: 7 },
];
