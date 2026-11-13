import { startApp } from './app.ts';
import { loadConfig } from './config.ts';

const app = await startApp(loadConfig());
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close().then(() => process.exit(0)));
}
// A stray rejection must not take every live room down with it.
process.on('unhandledRejection', (reason) => console.error('unhandled rejection:', reason));
