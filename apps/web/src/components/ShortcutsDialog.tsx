import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

const SHORTCUTS: [string, string][] = [
  ['F2', 'Search customers (on sale and payment screens)'],
  ['F3', 'Search products (on sale and purchase screens)'],
  ['F4', 'New sale'],
  ['Ctrl + S', 'Save'],
  ['Ctrl + Enter', 'Save the sale and share it'],
  ['Enter', 'Next field in item grids'],
  ['Esc', 'Close a dialog'],
  ['?', 'Show this list'],
];

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Some shortcuts work only on the screens that use them.</DialogDescription>
        </DialogHeader>
        <table className="w-full text-[15px]">
          <tbody>
            {SHORTCUTS.map(([key, what]) => (
              <tr key={key} className="border-b border-border last:border-0">
                <td className="w-32 py-2">
                  <kbd className="rounded border border-border bg-muted px-2 py-0.5 font-mono text-sm">{key}</kbd>
                </td>
                <td className="py-2">{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </DialogContent>
    </Dialog>
  );
}
