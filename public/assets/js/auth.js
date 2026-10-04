// Sign up, log in, forgot and reset password. Mode comes from the path.

import { $, api, applyTheme, clear, h } from './lib.js';

applyTheme();
const app = $('#app');
const mode = location.pathname.slice(1) || 'login';
const params = new URLSearchParams(location.search);

// Only same-origin paths: "//evil.example" or "/\\evil" must not leave the site.
function safeNext(next) {
  if (!next) return '/app';
  try {
    const u = new URL(next, location.origin);
    return u.origin === location.origin && next.startsWith('/') && !next.startsWith('//') ? u.pathname + u.search + u.hash : '/app';
  } catch {
    return '/app';
  }
}

const input = (name, label, attrs = {}) => h('label', { class: 'field' }, h('span', {}, label), h('input', { name, ...attrs }));
const error = () => h('p', { class: 'notice danger', id: 'err', hidden: true });

function showError(form, message) {
  const el = form.querySelector('#err');
  el.textContent = message;
  el.hidden = false;
}

function submitHandler(form, run) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    form.querySelector('#err').hidden = true;
    const button = form.querySelector('button[type=submit]');
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'One moment…';
    try {
      await run(Object.fromEntries(new FormData(form)));
    } catch (err) {
      showError(form, err.message);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  });
  return form;
}

function zones() {
  const guess = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles';
  const common = ['America/Los_Angeles', 'America/Denver', 'America/Phoenix', 'America/Chicago', 'America/New_York', 'America/Anchorage', 'Pacific/Honolulu'];
  const list = [...new Set([guess, ...common])];
  return h('select', { name: 'timezone' }, list.map((z) => h('option', { value: z, selected: z === guess }, z.replace('_', ' '))));
}

const views = {
  login() {
    document.title = 'Log in';
    return submitHandler(
      h(
        'form',
        {},
        h('h1', {}, 'Log in'),
        error(),
        input('email', 'Email', { type: 'email', autocomplete: 'username', required: true }),
        input('password', 'Password', { type: 'password', autocomplete: 'current-password', required: true }),
        h('button', { type: 'submit', class: 'btn primary block' }, 'Log in'),
        h('p', { class: 'small', style: { marginTop: '14px' } }, h('a', { href: '/forgot' }, 'Forgot password?'), ' · ', h('a', { href: '/signup' }, 'Create an account')),
      ),
      async (v) => {
        await api('/api/auth/login', { method: 'POST', body: v });
        location.href = safeNext(params.get('next'));
      },
    );
  },

  signup() {
    document.title = 'Start your free trial';
    return submitHandler(
      h(
        'form',
        {},
        h('h1', {}, 'Start your free trial'),
        h('p', { class: 'muted' }, '30 days free, no card. Then $1,000 once per location.'),
        error(),
        input('restaurantName', 'Restaurant name', { required: true, autocomplete: 'organization' }),
        input('name', 'Your name', { autocomplete: 'name' }),
        input('email', 'Email', { type: 'email', autocomplete: 'email', required: true }),
        input('password', 'Password', { type: 'password', autocomplete: 'new-password', required: true, minlength: 10 }),
        h('label', { class: 'field' }, h('span', {}, 'Time zone'), zones()),
        h('button', { type: 'submit', class: 'btn primary block' }, 'Create my book'),
        h('p', { class: 'small muted', style: { marginTop: '12px' } }, 'We set up a starter floor plan and dinner hours so you can take a test booking right away. Change everything later.'),
        h('p', { class: 'small' }, 'Already have an account? ', h('a', { href: '/login' }, 'Log in')),
      ),
      async (v) => {
        await api('/api/auth/signup', { method: 'POST', body: v });
        location.href = '/app#/settings/start';
      },
    );
  },

  forgot() {
    document.title = 'Reset your password';
    const form = submitHandler(
      h(
        'form',
        {},
        h('h1', {}, 'Reset your password'),
        error(),
        input('email', 'Email', { type: 'email', required: true, autocomplete: 'username' }),
        h('button', { type: 'submit', class: 'btn primary block' }, 'Email me a reset link'),
        h('p', { class: 'small', style: { marginTop: '14px' } }, h('a', { href: '/login' }, 'Back to log in')),
      ),
      async (v) => {
        const res = await api('/api/auth/forgot', { method: 'POST', body: v });
        clear(app, h('h1', {}, 'Check your email'), h('p', {}, res.message), h('a', { href: '/login' }, 'Back to log in'));
      },
    );
    return form;
  },

  reset() {
    const invite = params.get('invite') === '1';
    document.title = invite ? 'Set your password' : 'Choose a new password';
    return submitHandler(
      h(
        'form',
        {},
        h('h1', {}, invite ? 'Welcome aboard' : 'Choose a new password'),
        invite ? h('p', { class: 'muted' }, 'Set a password to join your team.') : null,
        error(),
        input('password', 'New password', { type: 'password', autocomplete: 'new-password', required: true, minlength: 10 }),
        h('button', { type: 'submit', class: 'btn primary block' }, 'Save password'),
      ),
      async (v) => {
        await api('/api/auth/reset', { method: 'POST', body: { token: params.get('token'), password: v.password } });
        clear(app, h('h1', {}, 'Password saved'), h('p', {}, 'You can log in now.'), h('a', { class: 'btn primary', href: '/login' }, 'Log in'));
      },
    );
  },
};

clear(app, (views[mode] || views.login)());
app.querySelector('input')?.focus();
