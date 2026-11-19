import { runTraderCycle } from '../agents/trader.agent';
import { computeCorrelationSnapshot } from '../services/correlation.service';
import { expireStaleSubscriptions, notifyExpiringPasses } from '../services/subscription.service';
import { logger } from '../lib/logger';
import { config } from '../config';
import { postgresContentStore } from '../services/content-store.service';
import { purgeExpiredIdempotencyKeys } from '../middlewares/idempotency.middleware';
import { computeAndStoreSnapshots } from '../services/calibration.service';
import { fitAndStoreMaps } from '../services/recalibration.service';
import { purgeSignalStore } from '../services/signal-store.service';
import { expireReservations } from '../services/market-reservation.service';
import { computeAndStoreRiskSnapshot } from '../services/portfolio-risk.service';
import { scheduleJob, type JobResult } from './registry';

/**
 * Position Monitor & Maintenance Crons — all scheduled via `scheduleJob` (#336).
 */
export function startMonitorCron(): void {
  // Correlation snapshot (#80) — every 15 minutes, just before the trader reads it.
  scheduleJob('correlation-snapshot', async () => {
    const snapshot = await computeCorrelationSnapshot();
    if (!snapshot) return { outcome: 'SKIPPED_LOCK_HELD' };
    return { outcome: 'SUCCESS', counters: { pairs: snapshot.pairs } };
  });

  // Portfolio risk snapshots (#280) — every 15 minutes, after correlation snapshot
  scheduleJob('portfolio-risk', async () => {
    await computeAndStoreRiskSnapshot();
    return { outcome: 'SUCCESS' };
  });

  // Trader Agent — every 15 minutes
  scheduleJob('trader', async ({ signal }) => {
    const res = await runTraderCycle({ signal });
    return { outcome: res.outcome };
  });

  // Calibration snapshots (#68) — daily at 03:10. The computation takes a
  // Postgres advisory lock, so with several instances only one does the work.
  scheduleJob('calibration', async () => {
    const run = await computeAndStoreSnapshots();
    if (!run) return { outcome: 'SKIPPED_LOCK_HELD' };
    // #244: refit per-category recalibration maps from the same resolved data.
    await fitAndStoreMaps().catch((err) => logger.warn({ err }, 'Monitor cron: recalibration refit failed'));
    return { outcome: 'SUCCESS' };
  });

  // Signal store retention (#73) — nightly at 03:41
  scheduleJob('signal-retention', async () => {
    const res = await purgeSignalStore();
    return {
      outcome: 'SUCCESS',
      counters: {
        rawPayloads: res.rawPayloads,
        fetches: res.fetches,
        signals: res.signals,
      },
    };
  });

  // Subscription expiry — every hour
  scheduleJob('subscription-expiry', async () => {
    const expired = await expireStaleSubscriptions();
    return { outcome: 'SUCCESS', counters: { expired } };
  });

  // PASS_EXPIRING socket events (#94) — every 10 minutes, once per pass.
  scheduleJob('pass-expiry-notify', async () => {
    const notified = await notifyExpiringPasses();
    return { outcome: 'SUCCESS', counters: { notified } };
  });

  // Expired Idempotency-Key rows (24h TTL, #123) — hourly at :10, in batches of 5 000
  scheduleJob('idempotency-purge', async () => {
    const deleted = await purgeExpiredIdempotencyKeys();
    if (deleted > 0) logger.info({ deleted }, 'Monitor cron: purged expired idempotency keys');
    return { outcome: 'SUCCESS', counters: { deleted } };
  });

  // Market reservation lease expiry (#283) — every 5 minutes
  scheduleJob('reservation-expiry', async () => {
    const expired = await expireReservations();
    return { outcome: 'SUCCESS', counters: { expired } };
  });

  // Copy trade sweep — every 5 minutes
  scheduleJob('copy-trade-sweep', sweepCopyTrades);

  // IPFS content eviction (#100) — hourly at :30, bounded batches.
  scheduleJob('ipfs-eviction', async () => {
    const result = await postgresContentStore.evict(config.IPFS_CACHE_BUDGET_BYTES);
    if (result.removed > 0) logger.info(result, 'Monitor cron: evicted IPFS content');
    return { outcome: 'SUCCESS', counters: { removed: result.removed } };
  });

  logger.info('Monitor cron started');
}

async function sweepCopyTrades(): Promise<JobResult> {
  const { prisma } = await import('../lib/prisma');
  const { CopyTradeStatus, expireStaleCopyTrades, verifyCopyTradeTx, CopyTradePendingError, notifyCopyTradeConfirmed } = await import('../services/copy-trade.service');
  const { toDisplayUsdc } = await import('../lib/amounts');
  const { AppError } = await import('../middlewares/error.middleware');

  await expireStaleCopyTrades();

  const confirming = await prisma.copyTrade.findMany({
    where: {
      status: CopyTradeStatus.CONFIRMING,
      verificationAttempts: { lt: 20 },
      txHash: { not: null },
    },
    include: { market: { select: { onChainMarketId: true } } },
    take: 20,
  });

  let confirmed = 0;
  let pending = 0;
  let failed = 0;

  for (const ct of confirming) {
    if (!ct.txHash || !ct.market?.onChainMarketId) continue;
    try {
      // Check chain_events first for stored Trade events
      const storedEvent = await prisma.chainEvent.findFirst({
        where: {
          txHash: ct.txHash,
          eventName: 'Trade',
          contractName: 'marketCore',
        },
      });
      if (storedEvent) {
        const params = storedEvent.params as any;
        const rawOutcome = params?.outcome;
        const outcomeTag = rawOutcome && typeof rawOutcome === 'object' && 'tag' in rawOutcome ? rawOutcome.tag : rawOutcome;
        const trader = params?.trader;
        const isBuy = Boolean(params?.is_buy);
        const marketId = BigInt(params?.market_id ?? -1);

        if (
          isBuy &&
          marketId === ct.market.onChainMarketId &&
          trader?.toLowerCase() === (ct as any).followerWallet.toLowerCase() &&
          (((ct as any).outcome === 'YES' && outcomeTag === 'Yes') || ((ct as any).outcome === 'NO' && outcomeTag === 'No'))
        ) {
          const collateral = BigInt(params?.collateral ?? 0);
          const done = await prisma.copyTrade.update({
            where: { id: ct.id },
            data: {
              status: CopyTradeStatus.EXECUTED,
              collateralRaw: collateral.toString(),
              sharesRaw: params?.shares ? String(params.shares) : null,
              feeRaw: params?.fee ? String(params.fee) : '0',
              ledger: storedEvent.ledger,
              chainEventId: storedEvent.id,
              confirmedAt: new Date(storedEvent.ledgerClosedAt),
              amount: toDisplayUsdc(collateral),
              failureCode: null,
            },
          });
          notifyCopyTradeConfirmed({ ...done, userId: done?.userId ?? ct.userId }, true);
          confirmed++;
          continue;
        }
      }

      // Otherwise verify via RPC
      const outcome = (ct as any).outcome === 'YES' ? 'Yes' : 'No';
      const maxCollateral = BigInt(ct.amountRaw ?? '0');
      const verified = await verifyCopyTradeTx({
        txHash: ct.txHash,
        trader: (ct as any).followerWallet,
        onChainMarketId: ct.market.onChainMarketId,
        outcome,
        maxCollateral,
      });

      const executed = await prisma.copyTrade.update({
        where: { id: ct.id },
        data: {
          status: CopyTradeStatus.EXECUTED,
          collateralRaw: verified.collateral.toString(),
          sharesRaw: verified.shares.toString(),
          feeRaw: verified.fee.toString(),
          ledger: verified.ledger,
          chainEventId: verified.eventId,
          confirmedAt: new Date(),
          amount: toDisplayUsdc(verified.collateral),
          failureCode: null,
        },
      });
      notifyCopyTradeConfirmed({ ...executed, userId: executed?.userId ?? ct.userId }, true);
      confirmed++;
    } catch (err: any) {
      if (err instanceof CopyTradePendingError) {
        await prisma.copyTrade.update({
          where: { id: ct.id },
          data: { verificationAttempts: { increment: 1 } },
        });
        pending++;
      } else if (err instanceof AppError && err.statusCode === 422) {
        await prisma.copyTrade.update({
          where: { id: ct.id },
          data: { status: CopyTradeStatus.FAILED, failureCode: err.code },
        });
        failed++;
      }
    }
  }

  return {
    outcome: 'SUCCESS',
    counters: { checked: confirming.length, confirmed, pending, failed },
  };
}
