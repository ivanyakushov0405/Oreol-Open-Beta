export function Toggle({ on, onChange, disabled }: { on: boolean; onChange?: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      className={'toggle' + (on ? ' on' : '')}
      style={disabled ? { opacity: 0.5 } : undefined}
      onClick={() => onChange?.(!on)}
    />
  );
}
