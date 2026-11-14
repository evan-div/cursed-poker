/** Tiny DOM helpers. Shared by every overlay so they stay consistent. */

export function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement('button');
  node.className = className;
  node.textContent = label;
  node.addEventListener('click', onClick);
  return node;
}

export function input(options: {
  placeholder: string;
  maxLength?: number;
  className?: string;
  value?: string;
  onInput?: (value: string) => void;
}): HTMLInputElement {
  const node = document.createElement('input');
  node.placeholder = options.placeholder;
  if (options.maxLength) node.maxLength = options.maxLength;
  if (options.className) node.className = options.className;
  if (options.value) node.value = options.value;
  if (options.onInput) node.addEventListener('input', () => options.onInput!(node.value));
  return node;
}

export function chips(amount: number): string {
  return amount.toLocaleString('en-US');
}

/**
 * How far the server's clock is ahead of this machine's, in milliseconds.
 *
 * Every deadline the server sends is in its own time. Comparing those against
 * `Date.now()` is only right on a machine whose clock agrees with the server's,
 * and a laptop five minutes fast showed five minutes missing from every blind
 * level. Each view carries the server's time, so the difference is known.
 */
let serverSkew = 0;

export function setServerTime(serverTime: number): void {
  serverSkew = serverTime - Date.now();
}

/** The server's idea of now, as near as this client can tell. */
export function serverNow(): number {
  return Date.now() + serverSkew;
}

export function countdown(endsAt: number | null): string {
  if (endsAt === null) return '--:--';
  const remaining = Math.max(0, endsAt - serverNow());
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1_000);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
