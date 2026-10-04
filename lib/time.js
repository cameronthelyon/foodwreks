// Time helpers.
//
// Restaurants think in local wall-clock time, so the system of record is a
// service date ("YYYY-MM-DD") plus minutes from local midnight. A late seating
// that runs past midnight keeps its service date and simply has minutes
// >= 1440. UTC instants are derived only when something needs a real clock
// (reminders, "too soon to book" checks). Intl does the timezone math.

const formatters = new Map();

function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const pad = (n) => String(n).padStart(2, '0');

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

export function zonedParts(ms, tz) {
  const out = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAY[out.weekday],
  };
}

// Offset of `tz` from UTC at instant `ms`, in milliseconds (PDT = -7h).
export function tzOffsetMs(ms, tz) {
  const p = zonedParts(ms, tz);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(ms / 1000) * 1000;
}

// Local service date + minutes from midnight -> UTC epoch ms.
// Nonexistent local times (spring forward) shift by the DST gap; ambiguous
// ones (fall back) resolve to the first occurrence. Neither matters for
// restaurant hours in practice, but neither throws.
export function zonedToUtc(date, minutes, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d) + minutes * 60000;
  const first = tzOffsetMs(wall, tz);
  let utc = wall - first;
  const second = tzOffsetMs(utc, tz);
  if (second !== first) utc = wall - second;
  return utc;
}

export function localDate(ms, tz) {
  const p = zonedParts(ms, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function localMinutes(ms, tz) {
  const p = zonedParts(ms, tz);
  return p.hour * 60 + p.minute;
}

export function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function dayNumber(date) {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

export function addDays(date, n) {
  return new Date((dayNumber(date) + n) * 86400000).toISOString().slice(0, 10);
}

export function daysBetween(from, to) {
  return dayNumber(to) - dayNumber(from);
}

// Service-date minutes -> the calendar day and clock a guest sees. Friday's
// minute 1470 is Saturday 12:30 AM.
export function calendarSlot(date, minutes) {
  const days = Math.floor(minutes / 1440);
  return { date: days ? addDays(date, days) : date, minutes: minutes - days * 1440 };
}

export function weekdayOf(date) {
  return new Date(dayNumber(date) * 86400000).getUTCDay();
}

// "17:30" -> 1050. Hours up to 30 are allowed so a bar can say "25:30"
// for 1:30 AM on the same service date.
export function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 30 || min > 59) return null;
  return h * 60 + min;
}

export function fmtHHMM(minutes) {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

export function fmt12(minutes) {
  const h24 = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const suffix = h24 < 12 ? 'AM' : 'PM';
  return `${h24 % 12 || 12}:${pad(m)} ${suffix}`;
}

const longDate = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

export function fmtDateLong(date) {
  return longDate.format(new Date(dayNumber(date) * 86400000));
}
