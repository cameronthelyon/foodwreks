// Entry point: load config, open the database, serve HTTP, run the worker.

import { createServer } from 'node:http';
import { loadConfig, loadDotEnv } from './lib/config.js';
import { createApp } from './lib/app.js';
import { startWorker } from './lib/worker.js';
import { seedDemo } from './lib/demo.js';

loadDotEnv();
const config = loadConfig();
const app = createApp(config);

if (config.demo) {
  const demo = await seedDemo(app);
  if (demo.created) console.log(`Demo data loaded. Log in at ${config.baseUrl}/login as ${demo.email} / ${demo.password}`);
  else console.log(`Demo data already present. Log in as ${demo.email} / ${demo.password}`);
}

const server = createServer(app.handle);
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
const worker = config.workerEnabled ? startWorker(app) : null;

server.listen(config.port, () => {
  console.log(`${config.brand.name} listening on ${config.baseUrl} (port ${config.port})`);
  if (config.email.provider === 'console') console.log('Email provider: console (messages are printed, not sent).');
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  worker?.stop();
  server.close(() => {
    app.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
