// App-wide state and data loading. Views subscribe to events on `bus`.

import { api } from '../lib.js';

export const state = {
  me: null,
  rid: null,
  restaurant: null,
  date: null,
  day: null,
  route: { view: 'book', arg: null, query: new URLSearchParams() },
};

export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export function on(type, fn) {
  bus.addEventListener(type, fn);
  return () => bus.removeEventListener(type, fn);
}

export const rApi = (path, opts) => api(`/api/r/${state.rid}${path}`, opts);

export async function loadRestaurant() {
  state.restaurant = await rApi('');
  emit('restaurant');
  return state.restaurant;
}

let dayRequest = 0;
export async function loadDay() {
  const mine = ++dayRequest;
  const data = await rApi(`/day/${state.date}`);
  if (mine !== dayRequest) return state.day;
  state.day = data;
  emit('day');
  return data;
}

export const STATUS = {
  pending: { label: 'Card pending', tone: 'violet' },
  booked: { label: 'Booked', tone: '' },
  confirmed: { label: 'Confirmed', tone: 'info' },
  arrived: { label: 'Arrived', tone: 'warn' },
  seated: { label: 'Seated', tone: 'ok' },
  completed: { label: 'Done', tone: '' },
  cancelled: { label: 'Cancelled', tone: 'danger' },
  no_show: { label: 'No-show', tone: 'danger' },
};

export const SOURCE = {
  online: 'Online',
  website: 'Website',
  google: 'Google',
  instagram: 'Instagram',
  phone: 'Phone',
  walkin: 'Walk-in',
  staff: 'Staff',
  import: 'Imported',
};

export const HOLDING = new Set(['pending', 'booked', 'confirmed', 'arrived', 'seated']);

export function tableName(id) {
  return state.day?.tables.find((t) => t.id === id)?.name ?? '?';
}
export const tableNames = (ids = []) => (ids.length ? ids.map(tableName).join('+') : 'No table');

const RANK = { host: 1, manager: 2, owner: 3 };
export const can = (minRole) => RANK[state.restaurant?.role] >= RANK[minRole];
