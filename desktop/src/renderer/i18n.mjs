import { messages } from './messages.mjs';
let locale = 'en';
export const getLocale = () => locale;
export function setLocale(value) {
  if (!['en', 'zh-CN'].includes(value)) throw Error('INVALID_LOCALE');
  locale = value;
}
const normalize = (value) => value.trim().replace(/\s+/g, ' ');
const reverse = new Map(Object.entries(messages).map(([zh, en]) => [normalize(en), zh]));
export function t(value, ...args) {
  const source = String(value ?? '');
  const key = normalize(source);
  const zh = Object.hasOwn(messages, key) ? key : reverse.get(key);
  const result = zh ? (locale === 'en' ? messages[zh] : zh) : source;
  const padded = zh ? source.match(/^\s*/)[0] + result + source.match(/\s*$/)[0] : result;
  return args.length ? padded.replace(/\{(\d+)\}/g, (all, i) => String(args[i] ?? all)) : padded;
}
const escape = (s) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const keys = Object.keys(messages)
  .filter((k) => !k.includes('{'))
  .sort((a, b) => b.length - a.length);
const pattern = new RegExp(
  keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).join('|'),
  'g',
);
// Only source-code-owned template segments pass here, never interpolated text or rendered HTML.
function segment(value, markup) {
  if (locale !== 'en') return value;
  return value.replace(pattern, (match) =>
    markup ? escape(messages[normalize(match)]) : messages[normalize(match)],
  );
}
export const htmlText = (value) => segment(value, true);
export function html(strings, ...values) {
  return strings.reduce(
    (out, part, i) => out + segment(part, true) + (i < values.length ? values[i] : ''),
    '',
  );
}
export function text(strings, ...values) {
  return strings.reduce(
    (out, part, i) => out + segment(part, false) + (i < values.length ? values[i] : ''),
    '',
  );
}
// Call only on the static application shell/token form, before runtime content is inserted.
const originals = new WeakMap();
export function localizeStatic(root) {
  const visit = (node) => {
    if (node.nodeType === 3) {
      if (!originals.has(node)) originals.set(node, node.textContent);
      node.textContent = segment(originals.get(node), false);
    } else if (node.nodeType === 1) {
      for (const attr of ['title', 'aria-label', 'placeholder']) {
        if (!node.hasAttribute(attr)) continue;
        let record = originals.get(node);
        if (!record) {
          record = {};
          originals.set(node, record);
        }
        record[attr] ??= node.getAttribute(attr);
        node.setAttribute(attr, segment(record[attr], false));
      }
      for (const child of node.childNodes) visit(child);
    }
  };
  visit(root);
}

// Match only known application event formats. Captured paths/IDs remain verbatim.
const eventFormats = Object.entries(messages).filter(([key]) => key.includes('{'));
export function translateEvent(value) {
  const source = String(value ?? '');
  for (const [zh, en] of eventFormats) {
    for (const format of [zh, en]) {
      const captures = [];
      const expression = format
        .split(/(\{\d+\})/)
        .map((part) => {
          if (/^\{\d+\}$/.test(part)) {
            captures.push(Number(part.slice(1, -1)));
            return '(.*?)';
          }
          return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('');
      const match = new RegExp('^' + expression + '$', 's').exec(source);
      if (match) {
        const args = [];
        captures.forEach((index, i) => {
          args[index] = match[i + 1];
        });
        return t(zh, ...args);
      }
    }
  }
  return t(source);
}
