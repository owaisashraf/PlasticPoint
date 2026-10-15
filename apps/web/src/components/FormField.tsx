import type { ReactNode } from 'react';
import { Label } from './ui/label';

export function FormField({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error && <p className="text-sm font-medium text-destructive">{error}</p>}
      {!error && hint && <p className="text-sm text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Copies server field errors ("changes.grace_days" / "username") onto a react-hook-form form. */
export function applyServerFieldErrors(
  fields: Record<string, string> | undefined,
  setError: (name: never, error: { message: string }) => void,
  prefix = '',
): boolean {
  if (!fields) return false;
  const entries = Object.entries(fields);
  for (const [path, message] of entries) {
    const name = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
    setError(name as never, { message });
  }
  return entries.length > 0;
}
