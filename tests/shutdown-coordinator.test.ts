/**
 * Shutdown coordinator unit tests (#264).
 * No DB or Redis needed — all deps are in-memory.
 */
import { describe, it, expect, beforeEach } from 'vitest';

// Re-import to get a fresh module state per test.
async function freshCoordinator() {
  // Vitest resets module registry between tests with isolateModules.
  const mod = await import('../src/lib/shutdown-coordinator');
  return mod;
}

describe('shutdown-coordinator', () => {
  it('runs handlers in stage order', async () => {
    const { onShutdown, runShutdown } = await freshCoordinator();
    const order: string[] = [];
    onShutdown('stop-intake',    'a', async () => { order.push('a'); }, 500);
    onShutdown('release-leases', 'b', async () => { order.push('b'); }, 500);
    onShutdown('stop-producers', 'c', async () => { order.push('c'); }, 500);
    await runShutdown(5_000);
    expect(order).toEqual(['a', 'c', 'b']);
  });

  it('reports ok outcome for successful step', async () => {
    const { onShutdown, runShutdown } = await freshCoordinator();
    onShutdown('stop-intake', 'noop', async () => {}, 500);
    const { steps } = await runShutdown(5_000);
    expect(steps[0]).toMatchObject({ name: 'noop', outcome: 'ok' });
  });

  it('reports timeout when step exceeds budget', async () => {
    const { onShutdown, runShutdown } = await freshCoordinator();
    onShutdown('stop-intake', 'slow', async () => new Promise((r) => setTimeout(r, 2_000)), 50);
    const { steps } = await runShutdown(5_000);
    expect(steps[0].outcome).toBe('timeout');
  });

  it('reports error outcome for a thrown step', async () => {
    const { onShutdown, runShutdown } = await freshCoordinator();
    onShutdown('stop-intake', 'boom', async () => { throw new Error('oops'); }, 500);
    const { steps } = await runShutdown(5_000);
    expect(steps[0]).toMatchObject({ outcome: 'error', error: 'oops' });
  });

  it('ignores duplicate runShutdown calls', async () => {
    const { onShutdown, runShutdown } = await freshCoordinator();
    let calls = 0;
    onShutdown('stop-intake', 'counter', async () => { calls++; }, 500);
    await runShutdown(5_000);
    const second = await runShutdown(5_000);
    expect(calls).toBe(1);
    expect(second.steps).toHaveLength(0);
  });
});
