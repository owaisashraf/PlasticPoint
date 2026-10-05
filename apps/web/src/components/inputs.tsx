import { XIcon } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';
import { Input } from './ui/input';

/** Rupee amount as text. The form converts it with parseRupeesToPaisa on save. */
export function MoneyInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">Rs</span>
      <Input inputMode="decimal" autoComplete="off" className={cn('amount pl-9', className)} {...props} />
    </div>
  );
}

/** Percentage as text ("12.5"). Converted with parsePercentToBp on save. */
export function PercentInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  return (
    <div className="relative">
      <Input inputMode="decimal" autoComplete="off" className={cn('amount pr-8', className)} {...props} />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
    </div>
  );
}

/**
 * A list of short values (sizes, colors). Type and press Enter or comma to
 * add; Backspace on an empty box removes the last one. Pasting "S, M, L" adds all.
 */
export function TagInput({
  id,
  value,
  onChange,
  placeholder,
}: {
  id?: string;
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState('');

  const add = (raw: string) => {
    const parts = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const next = [...value];
    for (const p of parts) if (!next.some((v) => v.toLowerCase() === p.toLowerCase())) next.push(p);
    if (next.length !== value.length) onChange(next);
    setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      if (text.trim()) {
        e.preventDefault();
        add(text);
      } else if (e.key === ',') e.preventDefault();
    } else if (e.key === 'Backspace' && !text && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input bg-card px-2 py-1 focus-within:outline-2 focus-within:outline-ring">
      {value.map((v) => (
        <span key={v} className="inline-flex items-center gap-1 rounded bg-secondary px-2 py-0.5 text-sm font-medium">
          {v}
          <button type="button" className="cursor-pointer opacity-60 hover:opacity-100" onClick={() => onChange(value.filter((x) => x !== v))} aria-label={`Remove ${v}`}>
            <XIcon className="size-3.5" />
          </button>
        </span>
      ))}
      <input
        id={id}
        className="min-w-24 flex-1 bg-transparent py-1 text-[15px] outline-none"
        value={text}
        placeholder={value.length ? '' : placeholder}
        onChange={(e) => (e.target.value.includes(',') ? add(e.target.value) : setText(e.target.value))}
        onKeyDown={onKeyDown}
        onBlur={() => text.trim() && add(text)}
      />
    </div>
  );
}
