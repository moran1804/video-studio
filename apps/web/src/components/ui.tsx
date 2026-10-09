'use client';

import clsx from 'clsx';
import { createContext, forwardRef, useCallback, useContext, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  loading?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-studio-accent/60 disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-4 py-2 text-sm',
        variant === 'primary' &&
          'bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white shadow-glow hover:from-violet-500 hover:to-fuchsia-500',
        variant === 'secondary' && 'border border-studio-line bg-white/5 text-zinc-100 hover:bg-white/10',
        variant === 'ghost' && 'text-zinc-300 hover:bg-white/5 hover:text-white',
        variant === 'danger' && 'border border-red-500/40 bg-red-500/10 text-red-200 hover:bg-red-500/20',
        className,
      )}
      {...rest}
    >
      {loading && <Spinner className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
});

/** Two-step confirm button (no browser dialogs). */
export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel = 'Click to confirm',
  ...rest
}: ButtonProps & { onConfirm: () => void | Promise<void>; confirmLabel?: string }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Button
      {...rest}
      loading={busy}
      variant={armed ? 'danger' : rest.variant}
      onClick={async () => {
        if (!armed) return setArmed(true);
        setBusy(true);
        try {
          await onConfirm();
        } finally {
          setBusy(false);
          setArmed(false);
        }
      }}
    >
      {armed ? confirmLabel : children}
    </Button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={clsx(
        'inline-block animate-spin rounded-full border-2 border-current border-t-transparent',
        className ?? 'h-4 w-4',
      )}
      aria-hidden
    />
  );
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

/**
 * Labelled form field. Use `group` when the field contains several controls
 * (e.g. a row of buttons) – a <label> would otherwise name only the first one.
 */
export function Field({
  label,
  hint,
  children,
  className,
  group,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  group?: boolean;
}) {
  const inner = (
    <>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-studio-muted">{hint}</span>}
    </>
  );
  if (group) {
    return (
      <div role="group" aria-label={label} className={clsx('block', className)}>
        {inner}
      </div>
    );
  }
  return <label className={clsx('block', className)}>{inner}</label>;
}

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={clsx('input', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={clsx('input min-h-[80px] resize-y', className)} {...rest} />;
  },
);

export function Select({ className, children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={clsx('input appearance-none bg-[length:12px] pr-8', className)} {...rest}>
      {children}
    </select>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={clsx(
        'flex cursor-pointer items-center justify-between gap-3 text-sm',
        disabled && 'opacity-50',
      )}
    >
      <span className="text-zinc-200">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx(
          'relative h-6 w-11 shrink-0 rounded-full transition',
          checked ? 'bg-studio-accent' : 'bg-zinc-700',
        )}
      >
        <span
          className={clsx(
            'absolute top-0.5 h-5 w-5 rounded-full bg-white transition',
            checked ? 'left-[22px]' : 'left-0.5',
          )}
        />
      </button>
    </label>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  return (
    <label className="block">
      <span className="flex justify-between text-xs text-studio-muted">
        <span className="font-medium uppercase tracking-wide">{label}</span>
        <span className="tabular-nums text-zinc-300">{format ? format(value) : value}</span>
      </span>
      <input
        type="range"
        className="mt-1 w-full"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export function Card({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={clsx('card', className)} {...rest}>
      {children}
    </div>
  );
}

export function SectionTitle({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="font-display text-lg font-semibold text-white">{title}</h2>
        {subtitle && <p className="mt-0.5 text-sm text-studio-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-zinc-700/60 text-zinc-200',
  none: 'bg-zinc-700/60 text-zinc-200',
  queued: 'bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/30',
  running: 'bg-violet-500/15 text-violet-200 ring-1 ring-violet-500/30',
  generating: 'bg-violet-500/15 text-violet-200 ring-1 ring-violet-500/30',
  rendering: 'bg-violet-500/15 text-violet-200 ring-1 ring-violet-500/30',
  completed: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30',
  exported: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30',
  ready: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30',
  approved: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30',
  brief_approved: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30',
  limited: 'bg-amber-500/15 text-amber-200 ring-1 ring-amber-500/30',
  failed: 'bg-red-500/15 text-red-300 ring-1 ring-red-500/30',
  attention: 'bg-red-500/15 text-red-300 ring-1 ring-red-500/30',
  cancelled: 'bg-zinc-600/40 text-zinc-300',
};

export function Badge({
  status,
  children,
  className,
}: {
  status?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const active = status && ['queued', 'running', 'generating', 'rendering'].includes(status);
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium',
        STATUS_STYLES[status ?? ''] ?? 'bg-white/10 text-zinc-200',
        className,
      )}
    >
      {active && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function ProgressBar({
  value,
  className,
  indeterminate,
}: {
  value: number;
  className?: string;
  indeterminate?: boolean;
}) {
  return (
    <div className={clsx('h-1.5 w-full overflow-hidden rounded-full bg-white/10', className)}>
      <div
        className={clsx(
          'h-full rounded-full bg-gradient-to-r from-violet-500 via-fuchsia-500 to-violet-500 transition-all',
          indeterminate && 'progress-animated',
        )}
        style={{ width: `${Math.max(indeterminate ? 30 : 2, Math.min(100, value * 100))}%` }}
      />
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-studio-line px-6 py-12 text-center">
      <p className="font-display text-base font-semibold text-white">{title}</p>
      {children && <div className="mt-1 max-w-md text-sm text-studio-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
      {children}
    </div>
  );
}

export function InfoNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-studio-line bg-white/5 px-3 py-2 text-sm text-zinc-300">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'error' | 'success';
}

const ToastContext = createContext<{ toast: (message: string, tone?: Toast['tone']) => void }>({
  toast: () => undefined,
});

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);
  const toast = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 8000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(92vw,380px)] flex-col gap-2"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={clsx(
              'pointer-events-auto rounded-xl border px-4 py-3 text-sm shadow-xl backdrop-blur',
              t.tone === 'error' && 'border-red-500/40 bg-red-950/90 text-red-100',
              t.tone === 'success' && 'border-emerald-500/40 bg-emerald-950/90 text-emerald-100',
              t.tone === 'info' && 'border-studio-line bg-studio-panel/95 text-zinc-100',
            )}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext).toast;
}

/** Wrap an async action with loading state and error toasts. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(key: string, fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      setBusy(key);
      try {
        const r = await fn();
        if (success) toast(success, 'success');
        return r;
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );
  return { busy, run };
}
