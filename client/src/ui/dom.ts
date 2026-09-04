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

export function countdown(endsAt: number | null): string {
  if (endsAt === null) return '--:--';
  const remaining = Math.max(0, endsAt - Date.now());
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1_000);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
