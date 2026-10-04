// RFC 4180 CSV parsing and writing.

export function parseCsv(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

// Spreadsheet apps execute cells that start with = + - @. Neutralize those,
// but leave phone numbers like +14155550123 readable.
function neutralize(value) {
  const v = String(value);
  if (/^[=@\t\r]/.test(v)) return `'${v}`;
  if (/^[+-]/.test(v) && !/^[+-][\d\s().-]*$/.test(v)) return `'${v}`;
  return v;
}

export function toCsv(rows, columns) {
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = neutralize(typeof v === 'object' ? JSON.stringify(v) : v);
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = [columns.map((c) => cell(c.label)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => cell(typeof c.get === 'function' ? c.get(r) : r[c.key])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
