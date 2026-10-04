// Navigation helpers shared by the shell and the views.

import { emit, loadDay, state } from './state.js';

export const DATED = new Set(['book', 'floor']);

export function go(view, arg) {
  location.hash = `#/${view}${arg ? `/${arg}` : ''}`;
}

export function setDate(date) {
  state.date = date;
  state.day = null;
  if (DATED.has(state.route.view)) go(state.route.view, date);
  else {
    emit('date');
    loadDay().catch(() => {});
  }
}
