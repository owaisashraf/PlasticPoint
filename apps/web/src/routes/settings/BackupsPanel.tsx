import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BackupFile, BackupLogEntry } from '@shopledger/shared';
import { DatabaseBackup, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { BACKUP_STATUS_KEY } from '@/components/BackupFooter';
import { FormField } from '@/components/FormField';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useClearSession } from '@/features/auth/useAuth';
import { api, errorMessage } from '@/lib/api';
import { formatBytes, formatDateTime } from '@/lib/utils';

const BACKUPS_KEY = ['backups'] as const;

const TRIGGER_LABEL: Record<BackupLogEntry['trigger'], string> = {
  scheduled: 'Daily',
  startup: 'At start-up',
  shutdown: 'At closing',
  manual: 'Manual',
  pre_restore: 'Before restore',
};

export function BackupsPanel() {
  const qc = useQueryClient();
  const [restoring, setRestoring] = useState<BackupFile | null>(null);
  const data = useQuery({
    queryKey: BACKUPS_KEY,
    queryFn: () => api.get<{ files: BackupFile[]; log: BackupLogEntry[] }>('/api/backups'),
  });

  const backupNow = useMutation({
    mutationFn: () => api.post<{ entry: BackupLogEntry }>('/api/backups'),
    onSuccess: ({ entry }) => {
      void qc.invalidateQueries({ queryKey: BACKUPS_KEY });
      void qc.invalidateQueries({ queryKey: BACKUP_STATUS_KEY });
      if (entry.status === 'ok') {
        toast.success(`Backup saved: ${entry.file_name}`);
        if (entry.second_copy_status === 'failed') toast.warning(`Copy to the second folder failed: ${entry.second_copy_error}`);
      } else toast.error(`Backup FAILED: ${entry.error}`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Card className="mt-4">
      <CardHeader className="flex-row items-start justify-between">
        <div>
          <CardTitle>Backup files</CardTitle>
          <CardDescription>Kept: 30 daily and 12 monthly backups. Safety copies made before a restore are never deleted.</CardDescription>
        </div>
        <Button onClick={() => backupNow.mutate()} disabled={backupNow.isPending}>
          <DatabaseBackup /> {backupNow.isPending ? 'Backing up…' : 'Back up now'}
        </Button>
      </CardHeader>
      <CardContent>
        {data.isPending && <p>Loading…</p>}
        {data.isError && <p className="text-destructive">{errorMessage(data.error)}</p>}
        {data.data && (
          <>
            <table className="w-full text-[15px]">
              <thead>
                <tr className="border-b border-border text-left text-sm text-muted-foreground">
                  <th className="py-2">File</th>
                  <th>Saved</th>
                  <th className="text-right">Size</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.data.files.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-4 text-muted-foreground">
                      No backups yet.
                    </td>
                  </tr>
                )}
                {data.data.files.map((f) => (
                  <tr key={f.file_name} className="border-b border-border last:border-0">
                    <td className="py-2 font-mono text-sm">
                      {f.file_name} {f.is_pre_restore && <Badge variant="info">Safety copy</Badge>}
                    </td>
                    <td>{formatDateTime(f.modified_at)}</td>
                    <td className="amount">{formatBytes(f.size_bytes)}</td>
                    <td className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => setRestoring(f)}>
                        <RotateCcw /> Restore
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h4 className="mb-2 mt-6 font-bold">Recent backup activity</h4>
            <ul className="flex flex-col gap-1 text-sm">
              {data.data.log.slice(0, 10).map((e) => (
                <li key={e.id}>
                  {formatDateTime(e.started_at)} · {TRIGGER_LABEL[e.trigger]} ·{' '}
                  {e.status === 'ok' ? <Badge variant="success">OK</Badge> : <Badge variant="danger">FAILED</Badge>}{' '}
                  {e.error && <span className="text-destructive">{e.error}</span>}
                  {e.second_copy_status === 'failed' && <span className="text-warning"> · second copy failed: {e.second_copy_error}</span>}
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
      {restoring && <RestoreDialog file={restoring} onClose={() => setRestoring(null)} />}
    </Card>
  );
}

function RestoreDialog({ file, onClose }: { file: BackupFile; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const clearSession = useClearSession();
  const navigate = useNavigate();

  const restore = useMutation({
    mutationFn: () => api.post<{ safety_backup: string }>('/api/backups/restore', { file_name: file.file_name, reason }),
    onSuccess: (r) => {
      toast.success(`Restored. A safety copy of the previous data was saved as ${r.safety_backup}. Please log in again.`, {
        duration: 15000,
      });
      clearSession();
      navigate('/login', { replace: true });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const ready = reason.trim().length >= 3 && confirmText.trim().toUpperCase() === 'RESTORE';
  return (
    <Dialog open onOpenChange={(o) => !o && !restore.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restore this backup?</DialogTitle>
          <DialogDescription>
            All data will go back to how it was on <strong>{formatDateTime(file.modified_at)}</strong>. Anything entered after that will
            be removed from the app (a safety copy of the current data is saved first). Everyone will be logged out.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <FormField label="Reason" htmlFor="restore_reason">
            <Input id="restore_reason" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
          <FormField label='Type "RESTORE" to confirm' htmlFor="restore_confirm">
            <Input id="restore_confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={restore.isPending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => restore.mutate()} disabled={!ready || restore.isPending}>
            {restore.isPending ? 'Restoring…' : 'Restore'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
