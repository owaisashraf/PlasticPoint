import type { ReactNode } from 'react';
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
import { NewPurchasePage } from './routes/purchases/NewPurchasePage';
import { PurchaseDetailPage } from './routes/purchases/PurchaseDetailPage';
import { PurchasesPage } from './routes/purchases/PurchasesPage';
import { NewSalePage } from './routes/sales/NewSalePage';
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
  '/change-history': <ChangeHistoryPage />,
};

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
        <Route
          path="/customers/:id"
          element={
            <Guard permission="customers.view">
              <CustomerDetailPage />
            </Guard>
          }
        />
        <Route
          path="/products/:id"
          element={
            <Guard permission="products.view">
              <ProductDetailPage />
            </Guard>
          }
        />
        <Route
          path="/sales/:id"
          element={
            <Guard permission="sales.view">
              <SaleDetailPage />
            </Guard>
          }
        />
        <Route
          path="/purchases/new"
          element={
            <Guard permission="purchases.create">
              <NewPurchasePage />
            </Guard>
          }
        />
        <Route
          path="/purchases/:id"
          element={
            <Guard permission="purchases.view">
              <PurchaseDetailPage />
            </Guard>
          }
        />
        <Route path="/account" element={<AccountPage />} />
        <Route path="*" element={<FullPageMessage title="Page not found" detail="Use the menu on the left." inline />} />
      </Route>
    </Routes>
  );
}
