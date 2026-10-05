import { cn } from '@/lib/utils';

export function FullPageMessage({ title, detail, inline = false }: { title: string; detail?: string; inline?: boolean }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 p-8 text-center', inline ? 'py-24' : 'min-h-screen')}>
      <h1 className="text-xl font-bold">{title}</h1>
      {detail && <p className="max-w-md text-muted-foreground">{detail}</p>}
    </div>
  );
}
