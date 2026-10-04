// Landing page payback calculator.

import { $, applyTheme, money } from './lib.js';

applyTheme();
const PRICE_CENTS = 100000;

function update() {
  const fee = Math.max(0, Number($('#c-fee').value) || 0);
  const covers = Math.max(0, Number($('#c-covers').value) || 0);
  const rate = Math.max(0, Number($('#c-rate').value) || 0);
  const yearCents = Math.round((fee + covers * rate) * 12 * 100);
  $('#c-year').textContent = money(yearCents);
  if (yearCents <= 0) {
    $('#c-payback').textContent = 'n/a';
    $('#c-five').textContent = money(-PRICE_CENTS);
    return;
  }
  const days = Math.ceil(PRICE_CENTS / (yearCents / 365));
  $('#c-payback').textContent = days > 3650 ? 'over 10 years' : `${days} ${days === 1 ? 'day' : 'days'}`;
  $('#c-five').textContent = money(yearCents * 5 - PRICE_CENTS);
}

for (const id of ['#c-fee', '#c-covers', '#c-rate']) $(id)?.addEventListener('input', update);
if ($('#calc')) update();
