// Loads the demo restaurant into the configured database (idempotent).
//   npm run seed

import { loadConfig, loadDotEnv } from '../lib/config.js';
import { createApp } from '../lib/app.js';
import { seedDemo } from '../lib/demo.js';

loadDotEnv();
const app = createApp(loadConfig(), { quiet: true });
const result = await seedDemo(app);
console.log(result.created ? `Demo restaurant created. Log in as ${result.email} / ${result.password}` : `Demo data already present (${result.email}).`);
app.close();
