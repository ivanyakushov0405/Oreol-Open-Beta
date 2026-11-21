import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../icons';

export type ToastKind = 'info' | 'success' | 'error';

/** Всплывающее сообщение внизу экрана: info — нейтральное, success — зелёное, error — красное. */
export function useToast() {
  const [msg, setMsg] = useState<{ text: string; kind: ToastKind; id: number } | null>(null);
  useEffect(() => {
    if (!msg) return;
    const id = window.setTimeout(() => setMsg(null), 3200);
    return () => window.clearTimeout(id);
  }, [msg]);
  const show = useCallback((text: string | null, kind: ToastKind = 'info') => setMsg(text ? { text, kind, id: Date.now() } : null), []);
  return {
    toast: msg ? (
      <div key={msg.id} className={`toast toast-${msg.kind}`} role={msg.kind === 'error' ? 'alert' : 'status'}>
        {msg.kind !== 'info' && <Icon name={msg.kind === 'success' ? 'check' : 'alert'} />}
        <span>{msg.text}</span>
      </div>
    ) : null,
    show,
  };
}

/** Плашка сверху: нет связи с сервером / переподключение голоса. */
export function ConnBanner({ text, tone = 'warn' }: { text: string; tone?: 'warn' | 'error' }) {
  return (
    <div className={`conn-banner conn-${tone}`} role="status">
      <span className="conn-spin" />
      <span>{text}</span>
    </div>
  );
}
