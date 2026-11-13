import { X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { PublicUser } from '../../shared/protocol.ts';
import { toast } from './store.ts';

export function Avatar({ user, size = 34, presence }: { user: Pick<PublicUser, 'displayName' | 'avatarColor'>; size?: number; presence?: boolean }) {
  return (
    <div className="avatar" style={{ width: size, height: size, fontSize: size * 0.4, background: `linear-gradient(135deg, ${user.avatarColor}, ${user.avatarColor}99)` }}>
      {user.displayName.trim().charAt(0) || '?'}
      {presence !== undefined && <i className={`presence ${presence ? 'on' : ''}`} />}
    </div>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />;
}

export function ToggleRow(p: { title: string; hint?: string; on: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <div className="toggle-row" style={p.disabled ? { opacity: 0.5, pointerEvents: 'none' } : undefined}>
      <div>
        <b>{p.title}</b>
        {p.hint && <small>{p.hint}</small>}
      </div>
      <Switch on={p.on} onChange={p.onChange} label={p.title} />
    </div>
  );
}

export function Segmented<T extends string | number>(p: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={p.label}>
      {p.options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === p.value} className={o.value === p.value ? 'on' : ''} onClick={() => p.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="row spread">
          <h2>{title}</h2>
          <button className="btn ghost icon sm" onClick={onClose} aria-label="Close"><X /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Runs an async UI action, surfacing failures as a toast. Returns a busy flag for disabling the trigger. */
export function useAction(): [boolean, (fn: () => Promise<unknown>, success?: string) => Promise<void>] {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try {
      await fn();
      if (success) toast('success', success);
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return [busy, run];
}

export async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('success', `${what} copied`);
  } catch {
    toast('error', 'Clipboard is not available');
  }
}

export function Stat(p: { label: string; value: string; unit?: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="card stat">
      <span className="label">{p.label}</span>
      <span className="value">{p.value}{p.unit && <small>{p.unit}</small>}</span>
      <span className="sub">{p.sub}</span>
      {p.children}
    </div>
  );
}

/** Minimal SVG line/area chart for live series. `null` values are gaps. */
export function Spark({ series, height = 44, max }: { series: { data: (number | null)[]; color: string }[]; height?: number; max?: number }) {
  const width = 300;
  const n = Math.max(...series.map((s) => s.data.length), 2);
  const peak = max ?? Math.max(1, ...series.flatMap((s) => s.data.map((v) => v ?? 0))) * 1.15;
  const path = (data: (number | null)[]): string => {
    let d = '';
    let pen = false;
    data.forEach((v, i) => {
      if (v === null) return void (pen = false);
      const x = (i / (n - 1)) * width;
      const y = height - 2 - (Math.min(v, peak) / peak) * (height - 4);
      d += `${pen ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} height={height} preserveAspectRatio="none" aria-hidden="true">
      {series.map((s, i) => (
        <path key={i} d={path(s.data)} fill="none" stroke={s.color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      ))}
    </svg>
  );
}

export const fmt = (v: number | null | undefined, digits = 0): string => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits));
export const fmtMbps = (kbps: number | null | undefined): string => (kbps === null || kbps === undefined ? '—' : (kbps / 1000).toFixed(kbps >= 10000 ? 1 : 2));
