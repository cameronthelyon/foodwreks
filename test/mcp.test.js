// AI agent server (MCP over HTTP): protocol handshake, the full booking
// journey through tools, and the rules that keep it no looser than the
// booking page.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { signup, startTestApp } from './helpers.js';

let t;
before(async () => {
  t = await startTestApp();
});
after(() => t.close());
beforeEach(() => t.app.limiter.reset());

let nextId = 1;
async function rpc(method, params, headers = {}) {
  const res = await fetch(`${t.base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  return { status: res.status, body: res.status === 202 ? null : await res.json() };
}
const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).body.result;

test('handshake: initialize, notifications, tools/list', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.ok(init.body.result.capabilities.tools);
  assert.match(init.body.result.instructions, /manage_url/);
  const unknownVersion = await rpc('initialize', { protocolVersion: '1999-01-01' });
  assert.equal(unknownVersion.body.result.protocolVersion, '2025-11-25', 'offers the newest it supports');

  const note = await fetch(`${t.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(note.status, 202);

  const list = await rpc('tools/list', {});
  const names = list.body.result.tools.map((x) => x.name);
  assert.deepEqual(names, ['search_restaurants', 'get_restaurant', 'check_availability', 'book_table', 'get_booking', 'change_booking', 'cancel_booking']);
  assert.equal(list.body.result.tools.find((x) => x.name === 'cancel_booking').annotations.destructiveHint, true);
  assert.equal((await rpc('ping', {})).body.result && true, true);
  assert.equal((await rpc('resources/list', {})).body.error.code, -32601);
});

test('protocol guards: other websites, bad versions, bad JSON, GET', async () => {
  assert.equal((await rpc('tools/list', {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await rpc('tools/list', {}, { origin: 'http://localhost' })).status, 200, 'our own origin is fine');
  assert.equal((await rpc('tools/list', {}, { 'mcp-protocol-version': '1999-01-01' })).status, 400);
  const bad = await fetch(`${t.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, -32700);
  assert.equal((await fetch(`${t.base}/mcp`)).status, 405);
  assert.equal((await rpc('tools/call', { name: 'nope', arguments: {} })).body.error.code, -32602);
});

test('an agent finds, books, changes and cancels a table', async () => {
  const { rid, slug } = await signup(t, { restaurantName: 'Agent Bistro' });
  t.app.db.run("UPDATE restaurants SET city = 'Oakland', cuisine = 'Californian' WHERE id = ?", rid);

  const found = await call('search_restaurants', { query: 'oakland californian' });
  assert.equal(found.isError, undefined);
  assert.ok(found.structuredContent.restaurants.some((r) => r.restaurant === slug));

  const info = await call('get_restaurant', { restaurant: slug });
  assert.equal(info.structuredContent.name, 'Agent Bistro');

  const avail = await call('check_availability', { restaurant: slug, date: '2026-10-16', party_size: 2 });
  const slot = avail.structuredContent.open.find((s) => s.time === '19:00');
  assert.ok(slot, 'a 7 PM table is open');
  assert.equal(slot.label, '7:00 PM');

  const booked = await call('book_table', {
    restaurant: slug, date: '2026-10-16', time: '19:00', party_size: 2,
    first_name: 'Ada', last_name: 'Agent', phone: '4155550190', email: 'ada@agent.test',
    policy_accepted: info.structuredContent.policy ? true : undefined,
  });
  assert.equal(booked.isError, undefined, booked.content?.[0]?.text);
  assert.equal(booked.structuredContent.status, 'booked');
  assert.match(booked.structuredContent.manage_url, /\/m\/[A-Z0-9]+\?t=/);
  const row = t.app.db.one('SELECT * FROM reservations WHERE code = ?', booked.structuredContent.code);
  assert.equal(row.source, 'agent', 'reports show the channel');
  assert.equal(row.start_min, 19 * 60);

  // The same rules as the booking page: one active booking per person per day.
  const again = await call('book_table', { restaurant: slug, date: '2026-10-16', time: '20:00', party_size: 2, first_name: 'Ada', phone: '4155550190', policy_accepted: true });
  assert.equal(again.isError, true);
  assert.equal(again.structuredContent.error, 'duplicate');

  const url = booked.structuredContent.manage_url;
  const looked = await call('get_booking', { manage_url: url });
  assert.equal(looked.structuredContent.status, 'booked');
  assert.equal(looked.structuredContent.can_cancel_online, true);

  const moved = await call('change_booking', { manage_url: url, time: '20:00' });
  assert.equal(moved.isError, undefined, moved.content?.[0]?.text);
  assert.equal(moved.structuredContent.time, '8:00 PM');

  const cancelled = await call('cancel_booking', { manage_url: url });
  assert.equal(cancelled.structuredContent.status, 'cancelled');
});

test('agents get readable failures, never someone else\'s booking', async () => {
  const { slug } = await signup(t);
  assert.equal((await call('get_restaurant', { restaurant: 'no-such-place' })).isError, true);
  const forged = await call('get_booking', { manage_url: `${t.base}/m/ABCDEFGH?t=forged` });
  assert.equal(forged.isError, true);
  assert.match(forged.content[0].text, /not found/i);
  assert.equal((await call('get_booking', { manage_url: 'not a link' })).isError, true);
  assert.equal((await call('book_table', { restaurant: slug, date: '2026-10-16', party_size: 2, first_name: 'X' })).content[0].text, 'Missing time.');
  const badTime = await call('book_table', { restaurant: slug, date: '2026-10-16', time: 'dinner', party_size: 2, first_name: 'X', phone: '4155550191', policy_accepted: true });
  assert.equal(badTime.isError, true);
});

test('agent bookings are rate limited like the booking page', async () => {
  const { slug } = await signup(t);
  let last;
  for (let i = 0; i < 13; i++) {
    last = await call('book_table', { restaurant: slug, date: '2026-10-17', time: '18:00', party_size: 2, first_name: `R${i}`, phone: `41555502${String(i).padStart(2, '0')}`, policy_accepted: true });
  }
  assert.equal(last.isError, true);
  assert.match(last.content[0].text, /Too many requests/);
});
