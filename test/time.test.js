import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  daysBetween,
  fmt12,
  fmtDateLong,
  fmtHHMM,
  isValidDate,
  isValidTimeZone,
  localDate,
  localMinutes,
  parseHHMM,
  weekdayOf,
  zonedToUtc,
} from '../lib/time.js';

const LA = 'America/Los_Angeles';

test('zonedToUtc handles standard and daylight time', () => {
  // October: PDT, UTC-7
  assert.equal(new Date(zonedToUtc('2026-10-10', 19 * 60, LA)).toISOString(), '2026-10-11T02:00:00.000Z');
  // December: PST, UTC-8
  assert.equal(new Date(zonedToUtc('2026-12-10', 19 * 60, LA)).toISOString(), '2026-12-11T03:00:00.000Z');
  // After-midnight minutes stay on the service date's axis
  assert.equal(new Date(zonedToUtc('2026-10-10', 25 * 60, LA)).toISOString(), '2026-10-11T08:00:00.000Z');
});

test('zonedToUtc survives DST transitions without throwing', () => {
  const gap = zonedToUtc('2026-03-08', 150, LA); // 2:30 AM does not exist
  const fold = zonedToUtc('2026-11-01', 90, LA); // 1:30 AM happens twice
  assert.ok(Number.isFinite(gap));
  assert.equal(new Date(fold).toISOString(), '2026-11-01T08:30:00.000Z');
  // Evening service on the DST change days is exact
  assert.equal(new Date(zonedToUtc('2026-03-08', 18 * 60, LA)).toISOString(), '2026-03-09T01:00:00.000Z');
  assert.equal(new Date(zonedToUtc('2026-11-01', 18 * 60, LA)).toISOString(), '2026-11-02T02:00:00.000Z');
});

test('localDate and localMinutes round-trip', () => {
  const ms = zonedToUtc('2026-10-10', 17 * 60 + 45, LA);
  assert.equal(localDate(ms, LA), '2026-10-10');
  assert.equal(localMinutes(ms, LA), 17 * 60 + 45);
  assert.equal(localDate(ms, 'Asia/Tokyo'), '2026-10-11');
});

test('date arithmetic', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(daysBetween('2026-10-04', '2026-11-03'), 30);
  assert.equal(weekdayOf('2026-10-04'), 0);
  assert.equal(weekdayOf('2026-10-10'), 6);
  assert.equal(fmtDateLong('2026-10-10'), 'Saturday, October 10, 2026');
});

test('validation helpers', () => {
  assert.ok(isValidDate('2026-02-28'));
  assert.ok(!isValidDate('2026-02-30'));
  assert.ok(!isValidDate('2026-2-3'));
  assert.ok(isValidTimeZone(LA));
  assert.ok(!isValidTimeZone('Mars/Olympus_Mons'));
});

test('clock formatting', () => {
  assert.equal(parseHHMM('17:30'), 1050);
  assert.equal(parseHHMM('25:30'), 1530);
  assert.equal(parseHHMM('7:5'), null);
  assert.equal(parseHHMM('31:00'), null);
  assert.equal(fmtHHMM(1050), '17:30');
  assert.equal(fmt12(0), '12:00 AM');
  assert.equal(fmt12(720), '12:00 PM');
  assert.equal(fmt12(1050), '5:30 PM');
  assert.equal(fmt12(1470), '12:30 AM');
});
