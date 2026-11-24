import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, Copy, Wallet } from 'lucide-react';

/* ------------------------------------------------------------------ */
/* Clipboard                                                           */
/* ------------------------------------------------------------------ */
export function useCopy() {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = useCallback(async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopiedKey(key);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 1800);
  }, []);

  return { copiedKey, copy };
}

export function CopyButton({
  copied,
  onClick,
  label = 'Copy',
  copiedLabel = 'Copied',
  disabled,
  primary,
  iconOnly,
  ariaLabel,
}: {
  copied: boolean;
  onClick: () => void;
  label?: string;
  copiedLabel?: string;
  disabled?: boolean;
  primary?: boolean;
  iconOnly?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      className={`btn btn-sm ${primary ? 'btn-primary' : ''} ${iconOnly ? 'btn-icon' : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel ?? (iconOnly ? label : undefined)}
      title={iconOnly ? label : undefined}
    >
      {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      {!iconOnly && (copied ? copiedLabel : label)}
      <span className="sr-only" aria-live="polite">
        {copied ? copiedLabel : ''}
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Pills                                                               */
/* ------------------------------------------------------------------ */
export function RuntimePill({ runtime, small }: { runtime: 'evm' | 'michelson'; small?: boolean }) {
  return (
    <span
      className={`pill ${runtime === 'evm' ? 'pill-evm' : 'pill-michelson'} ${small ? 'pill-sm' : ''}`}
    >
      {runtime === 'evm' ? 'EVM' : 'Michelson'}
    </span>
  );
}

export type WalletNeed = 'none' | 'optional' | 'required';

export const WALLET_NEED_LABEL: Record<WalletNeed, string> = {
  none: 'No wallet needed',
  optional: 'Wallet optional',
  required: 'Wallet required',
};

export function WalletNeedPill({ need, label }: { need: WalletNeed; label?: string }) {
  return (
    <span className={`pill pill-sm ${need === 'required' ? 'pill-accent' : 'pill-muted'}`}>
      <Wallet size={11} aria-hidden="true" />
      {label ?? WALLET_NEED_LABEL[need]}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Step heading                                                        */
/* ------------------------------------------------------------------ */
export function StepTitle({
  n,
  title,
  hint,
  id,
  as: Tag = 'h3',
}: {
  n?: number | string;
  title: ReactNode;
  hint?: ReactNode;
  id?: string;
  as?: 'h2' | 'h3' | 'h4';
}) {
  return (
    <div className="step-title">
      {n !== undefined && (
        <span className="step-num" aria-hidden="true">
          {n}
        </span>
      )}
      <div style={{ minWidth: 0 }}>
        <Tag id={id} className="card-title">
          {n !== undefined && <span className="sr-only">Step {n}: </span>}
          {title}
        </Tag>
        {hint && <p className="card-subtitle">{hint}</p>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Accessible tab list with roving focus + arrow-key navigation        */
/* ------------------------------------------------------------------ */
export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  title?: string;
  done?: boolean;
}

export function tabId(prefix: string, id: string) {
  return `${prefix}-tab-${id}`;
}

export function panelId(prefix: string, id: string) {
  return `${prefix}-panel-${id}`;
}

export function TabList<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  idPrefix,
  className = 'seg',
  itemClassName = 'seg-item',
  orientation = 'horizontal',
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  ariaLabel: string;
  idPrefix: string;
  className?: string;
  itemClassName?: string;
  orientation?: 'horizontal' | 'vertical';
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = items.findIndex((item) => item.id === value);
    if (idx < 0) return;
    const prevKeys = orientation === 'vertical' ? ['ArrowUp', 'ArrowLeft'] : ['ArrowLeft', 'ArrowUp'];
    const nextKeys = orientation === 'vertical' ? ['ArrowDown', 'ArrowRight'] : ['ArrowRight', 'ArrowDown'];
    let next = -1;
    if (nextKeys.includes(e.key)) next = (idx + 1) % items.length;
    else if (prevKeys.includes(e.key)) next = (idx - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(items[next].id);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation={orientation}
      className={className}
      onKeyDown={onKeyDown}
    >
      {items.map((item, i) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={tabId(idPrefix, item.id)}
            aria-selected={selected}
            aria-controls={panelId(idPrefix, item.id)}
            tabIndex={selected ? 0 : -1}
            className={itemClassName}
            data-done={item.done ? 'true' : undefined}
            title={item.title}
            onClick={() => onChange(item.id)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({
  idPrefix,
  id,
  children,
  className,
}: {
  idPrefix: string;
  id: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="tabpanel"
      id={panelId(idPrefix, id)}
      aria-labelledby={tabId(idPrefix, id)}
      className={className}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Progress (e.g. Ready → Signing → Settled → View trace)              */
/* ------------------------------------------------------------------ */
export type ProgressState = 'todo' | 'active' | 'done' | 'error';

export function Progress({
  steps,
  ariaLabel,
}: {
  steps: { label: string; state: ProgressState }[];
  ariaLabel: string;
}) {
  return (
    <ol className="progress" aria-label={ariaLabel}>
      {steps.map((s) => (
        <li
          key={s.label}
          className="progress-step"
          data-state={s.state}
          aria-current={s.state === 'active' ? 'step' : undefined}
        >
          <span className="dot" aria-hidden="true" />
          {s.label}
          {s.state === 'done' && <span className="sr-only"> (done)</span>}
          {s.state === 'error' && <span className="sr-only"> (failed)</span>}
        </li>
      ))}
    </ol>
  );
}
