import { Plus } from 'lucide-react';
import { useNavigate } from 'react-router';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { useCan } from '@/features/auth/useAuth';
import { SalesTable } from '@/features/sales/SalesTable';

export function SalesPage() {
  const can = useCan();
  const navigate = useNavigate();
  return (
    <div>
      <PageHeader
        title="Sales"
        actions={
          can('sales.create') && (
            <Button onClick={() => navigate('/sales/new')} title="F4">
              <Plus /> New sale <kbd className="text-xs opacity-70">F4</kbd>
            </Button>
          )
        }
      />
      <SalesTable />
    </div>
  );
}
