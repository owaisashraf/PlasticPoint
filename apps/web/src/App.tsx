import type { ReactNode } from 'react';
import type { PermissionKey } from '@shopledger/shared';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { AppShell } from './components/AppShell';
import { ComingSoon } from './components/ComingSoon';
import { Guard } from './components/Guard';
import { NAV_ITEMS } from './components/nav';
import { FullPageMessage } from './components/FullPageMessage';
import { useMe, useSetupStatus } from './features/auth/useAuth';
import { AccountPage } from './routes/account/AccountPage';
import { ChangeHistoryPage } from './routes/change-history/ChangeHistoryPage';
import { CustomerDetailPage } from './routes/customers/CustomerDetailPage';
import { CustomersPage } from './routes/customers/CustomersPage';
import { DashboardPage } from './routes/dashboard/DashboardPage';
import { LoginPage } from './routes/login/LoginPage';
import { ProductDetailPage } from './routes/products/ProductDetailPage';
import { ProductsPage } from './routes/products/ProductsPage';
import { EditPurchasePage, NewPurchasePage } from './routes/purchases/NewPurchasePage';
import { PurchaseDetailPage } from './routes/purchases/PurchaseDetailPage';
import { PurchasesPage } from './routes/purchases/PurchasesPage';
import { AssetDetailPage } from './routes/assets/AssetDetailPage';
import { AssetsPage } from './routes/assets/AssetsPage';
import { ExpensesPage } from './routes/expenses/ExpensesPage';
import { OverduePage } from './routes/overdue/OverduePage';
import { ReportPage, ReportsPage } from './routes/reports/ReportsPage';
import { PaymentsPage } from './routes/payments/PaymentsPage';
import { ReturnsPage } from './routes/returns/ReturnsPage';
import { EditSalePage, NewSalePage } from './routes/sales/NewSalePage';
import { SaleDetailPage } from './routes/sales/SaleDetailPage';
import { SalesPage } from './routes/sales/SalesPage';
import { SettingsPage } from './routes/settings/SettingsPage';
import { SetupPage } from './routes/setup/SetupPage';

const BUILT_PAGES: Record<string, ReactNode> = {
  '/': <DashboardPage />,
  '/settings': <SettingsPage />,
  '/customers': <CustomersPage />,
  '/products': <ProductsPage />,
  '/sales/new': <NewSalePage />,
  '/sales': <SalesPage />,
  '/purchases': <PurchasesPage />,
  '/payments': <PaymentsPage />,
  '/returns': <ReturnsPage />,
  '/overdue': <OverduePage />,
  '/expenses': <ExpensesPage />,
  '/assets': <AssetsPage />,
  '/reports': <ReportsPage />,
  '/change-history': <ChangeHistoryPage />,
};

/** Pages that are not in the menu: details, edits and new purchases. */
const OTHER_PAGES: { path: string; permission: PermissionKey; element: ReactNode }[] = [
  { path: '/customers/:id', permission: 'customers.view', element: <CustomerDetailPage /> },
  { path: '/products/:id', permission: 'products.view', element: <ProductDetailPage /> },
  { path: '/reports/:key', permission: 'reports.operational', element: <ReportPage /> },
  { path: '/assets/:id', permission: 'assets.manage', element: <AssetDetailPage /> },
  { path: '/sales/:id/edit', permission: 'documents.edit_own_same_day', element: <EditSalePage /> },
  { path: '/purchases/:id/edit', permission: 'documents.edit_own_same_day', element: <EditPurchasePage /> },
  { path: '/sales/:id', permission: 'sales.view', element: <SaleDetailPage /> },
  { path: '/purchases/new', permission: 'purchases.create', element: <NewPurchasePage /> },
  { path: '/purchases/:id', permission: 'purchases.view', element: <PurchaseDetailPage /> },
];

export function App() {
  const setup = useSetupStatus();
  const me = useMe();
  const location = useLocation();

  if (setup.isPending || me.isPending) return <FullPageMessage title="Loading ShopLedger…" />;
  if (setup.isError || me.isError) {
    return (
      <FullPageMessage
        title="Cannot reach ShopLedger"
        detail="Check that ShopLedger is running on this computer, then reload this page."
      />
    );
  }

  // First run: the superuser, then (logged in as superuser) the owner.
  const needs = setup.data.needs;
  if (needs === 'superuser' || (needs === 'owner' && me.data?.user.role === 'superuser')) {
    return (
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }

  if (!me.data) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace state={{ from: location.pathname }} />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="/setup" element={<Navigate to="/" replace />} />
      <Route element={<AppShell />}>
        {NAV_ITEMS.map((item) => (
          <Route
            key={item.to}
            path={item.to}
            element={
              <Guard permission={item.permission}>
                {BUILT_PAGES[item.to] ?? <ComingSoon title={item.label} phase={item.phase} />}
              </Guard>
            }
          />
        ))}
        {OTHER_PAGES.map((page) => (
          <Route key={page.path} path={page.path} element={<Guard permission={page.permission}>{page.element}</Guard>} />
        ))}
        <Route path="/account" element={<AccountPage />} />
        <Route path="*" element={<FullPageMessage title="Page not found" detail="Use the menu on the left." inline />} />
      </Route>
    </Routes>
  );
}
