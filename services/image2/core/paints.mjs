import namedColors from './color-names.mjs';

const number = '[+\\-]?(?:\\d*\\.)?\\d+';
const functional = new RegExp(`^(rgb|rgba)\\(\\s*(${number}%?)\\s*,\\s*(${number}%?)\\s*,\\s*(${number}%?)(?:\\s*,\\s*(${number}%?))?\\s*\\)$`);
const clamp = (n, max) => Math.max(0, Math.min(max, n));

/** Explicit supported CSS literal subset. Never falls back to black for an unknown name. */
export function parseLiteralColor(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (text === 'transparent') return [0, 0, 0, 0];
  if (Object.hasOwn(namedColors, text)) return [...namedColors[text], 1];
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(text)) {
    const digits = text.length < 6 ? [...text.slice(1)].map(c => c + c).join('') : text.slice(1);
    return [parseInt(digits.slice(0, 2), 16), parseInt(digits.slice(2, 4), 16), parseInt(digits.slice(4, 6), 16), digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1];
  }
  const match = functional.exec(text);
  if (!match || (match[1] === 'rgba') !== (match[5] !== undefined)) return null;
  const channels = match.slice(2, 5).map(c => clamp(c.endsWith('%') ? parseFloat(c) * 255 / 100 : parseFloat(c), 255));
  const alpha = match[5] === undefined ? 1 : clamp(parseFloat(match[5]) / (match[5].endsWith('%') ? 100 : 1), 1);
  return [...channels, alpha];
}

export const isLiteralPaint = value => value === 'none' || parseLiteralColor(value) !== null;
