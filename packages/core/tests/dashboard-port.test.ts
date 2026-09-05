import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { PortUnavailableError } from '../src/shared/errors.js';

/**
 * Two dashboards on one machine is the normal case, not an edge case: a
 * developer with several repos open will start one per repo. Before this,
 * the second reported `EADDRINUSE` as an unexpected internal error, which
 * reads as a TokenLens bug rather than "something is already there".
 *
 * The behaviour under test lives in `cli/commands/dashboard.ts`; it is
 * reproduced here against a bare Fastify instance because the command
 * itself opens the real ledger and scans the real workspace storage.
 */
const PORT_SCAN_LIMIT = 20;

function isAddressInUse(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'EADDRINUSE';
}

async function listenOnFreePort(
  app: FastifyInstance,
  preferred: number,
  explicit: boolean,
): Promise<number> {
  const attempts = explicit ? 1 : PORT_SCAN_LIMIT;

  for (let offset = 0; offset < attempts; offset += 1) {
    const port = preferred + offset;
    try {
      await app.listen({ host: '127.0.0.1', port });
      return port;
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
      if (offset === attempts - 1) {
        throw new PortUnavailableError('busy', {
          port: preferred,
          attempted: offset + 1,
          explicit,
        });
      }
    }
  }
  throw new PortUnavailableError('busy', { port: preferred, attempted: attempts, explicit });
}

function occupy(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

describe('dashboard port selection', () => {
  const blockers: Server[] = [];
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(
      blockers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => {
              resolve();
            });
          }),
      ),
    );
  });

  async function freshApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    apps.push(app);
    await app.ready();
    return app;
  }

  it('takes the preferred port when it is free', async () => {
    const app = await freshApp();
    const port = await listenOnFreePort(app, 7401, false);
    expect(port).toBe(7401);
  });

  it('walks forward when the default is already taken', async () => {
    blockers.push(await occupy(7411));

    const app = await freshApp();
    const port = await listenOnFreePort(app, 7411, false);

    expect(port).toBe(7412);
  });

  it('keeps walking past a run of busy ports', async () => {
    blockers.push(await occupy(7421), await occupy(7422), await occupy(7423));

    const app = await freshApp();
    const port = await listenOnFreePort(app, 7421, false);

    expect(port).toBe(7424);
  });

  it('refuses to move an explicitly requested port', async () => {
    // Silently handing back 7432 to someone who asked for 7431 hides that
    // something else owns the address, and they will point a browser at the
    // port they asked for.
    blockers.push(await occupy(7431));

    const app = await freshApp();

    await expect(listenOnFreePort(app, 7431, true)).rejects.toThrow(PortUnavailableError);
  });

  it('reports how many ports it tried, so the message can be specific', async () => {
    blockers.push(await occupy(7441));
    const app = await freshApp();

    await listenOnFreePort(app, 7441, false).catch(() => undefined);

    const explicitApp = await freshApp();
    const error = await listenOnFreePort(explicitApp, 7441, true).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(PortUnavailableError);
    expect((error as PortUnavailableError).context).toMatchObject({
      port: 7441,
      attempted: 1,
      explicit: true,
    });
  });
});
