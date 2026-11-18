// main.ts — process entrypoint.
//
// Trial mode (MAKEFUN_ENV_URL set): bind an ephemeral port, register it with
// the harness, serve until the harness reports done, then exit 0. Dev mode
// (no env URL): bind a chosen or ephemeral port, print the URL, serve until
// interrupted. Either way the forge itself is the same in-memory store; the
// only difference is how the process learns when to stop.

import { createForgeServer } from './app.ts';
import { deriveViewer } from './scenario.ts';
import { ForgeStore } from './store.ts';

function trialNowSeconds(): number | null {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw === undefined || raw === '') return null;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber > 0) return Math.trunc(asNumber);
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return Math.trunc(parsed / 1000);
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(envUrl: string, port: number): Promise<boolean> {
  const endpoint = `${envUrl.replace(/\/$/, '')}/register`;
  let delay = 200;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(3000),
      });
      if (response.status === 200 || response.status === 201 || response.status === 204 || response.status === 409) return true;
    } catch {
      // The harness may not be listening yet; retry with backoff.
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
  return false;
}

async function waitForDone(envUrl: string): Promise<void> {
  const endpoint = `${envUrl.replace(/\/$/, '')}/done`;
  const deadline = Date.now() + 850_000;
  let delay = 400;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        const payload = (await response.json()) as { done?: boolean };
        if (payload.done === true) return;
      }
    } catch {
      // Transient harness hiccup; keep polling.
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, 2000);
  }
}

async function main(): Promise<void> {
  const store = new ForgeStore(deriveViewer(), trialNowSeconds());
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const server = createForgeServer({ store, expectedToken: token });

  const envUrl = process.env.MAKEFUN_ENV_URL;
  const requestedPort = Number(process.env.PORT ?? '');
  const listenPort = envUrl ? 0 : Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 0;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : listenPort;

  if (!envUrl) {
    console.log(`forge listening on http://127.0.0.1:${port}`);
    console.log('dev mode: no MAKEFUN_ENV_URL, serving until interrupted');
    await new Promise<void>((resolve) => {
      const shutdown = (): void => {
        server.close(() => resolve());
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    });
    return;
  }

  const registered = await register(envUrl, port);
  if (!registered) {
    console.error('failed to register with the harness');
    server.close();
    process.exit(1);
  }

  await waitForDone(envUrl);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
