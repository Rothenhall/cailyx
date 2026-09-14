import { cn } from '@/lib/utils';

type Variant = 'primary' | 'ghost' | 'danger';

export function Button({
  variant = 'ghost',
  className,
  disabled,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const base = 'inline-flex items-center justify-center gap-1.5 rounded-r2 px-3 py-1.5 text-ui transition-colors disabled:opacity-50 disabled:pointer-events-none';
  const variants: Record<Variant, string> = {
    primary: 'border border-cognac/40 bg-cognac/15 text-cognac hover:bg-cognac/25',
    ghost: 'border border-border bg-bg-inset text-dim hover:border-border-strong hover:text-text',
    danger: 'border border-red/30 bg-red/10 text-red hover:bg-red/20',
  };
  return (
    <button className={cn(base, variants[variant], className)} disabled={disabled} {...rest}>
      {children}
    </button>
  );
}
