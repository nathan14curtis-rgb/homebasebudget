/**
 * The app's amount field: a "$" prefix, a text input that brings up the
 * number keypad on a phone, and nothing else. Parsing lives in money.ts,
 * so a form checks what was typed with parseMoney() before sending it.
 */
export function MoneyInput({
  id,
  value,
  onChange,
  placeholder = "0.00",
  disabled,
  autoFocus,
  ariaLabel,
  width,
  style,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Focus this field when its dialog opens (see Modal). */
  autoFocus?: boolean;
  ariaLabel?: string;
  width?: number | string;
  style?: React.CSSProperties;
}) {
  return (
    <div className="input-prefix" style={{ ...(width !== undefined ? { width } : null), ...style }}>
      <span aria-hidden>$</span>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        data-autofocus={autoFocus ? "true" : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
