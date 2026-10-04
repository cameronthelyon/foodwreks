// Creates (or promotes) a platform admin and prints a one-time link to set
// the password, so no password is ever typed into a terminal or a log.
//   node scripts/create-admin.js you@freeheld.io "Your Name"
// On the server, use the wrapper: sudo /opt/freeheld/deploy/admin.sh you@freeheld.io

import { randomBytes } from 'node:crypto';
import { loadConfig, loadDotEnv } from '../lib/config.js';
import { createApp } from '../lib/app.js';
import { createResetToken, hashPassword, validateEmail } from '../lib/auth.js';

const [emailArg, nameArg = ''] = process.argv.slice(2);
if (!emailArg) {
  console.error('Usage: node scripts/create-admin.js <email> ["Full Name"]');
  process.exit(1);
}

loadDotEnv();
const app = createApp(loadConfig(), { quiet: true });
try {
  const email = validateEmail(emailArg);
  let user = app.db.one('SELECT id FROM users WHERE email = ?', email);
  if (!user) {
    // An unguessable password nobody knows; the link below replaces it.
    const hash = await hashPassword(randomBytes(32).toString('base64'));
    user = { id: app.db.run('INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)', email, nameArg.slice(0, 100), hash, app.now()).id };
    console.log(`Created ${email}.`);
  }
  app.db.run('UPDATE users SET is_platform_admin = 1 WHERE id = ?', user.id);
  const token = createResetToken(app, user.id, 24 * 3600_000);
  console.log(`${email} is a platform admin. Set the password within 24 hours:\n${app.config.baseUrl}/reset?token=${token}`);
} finally {
  app.close();
}
