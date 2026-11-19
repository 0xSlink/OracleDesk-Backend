import { confirmPendingPaymentIntents } from '../services/payment-intent.service';
import { scheduleJob } from './registry';

/**
 * Confirms submitted payment intents and expires abandoned ones (#52). The
 * per-hash advisory lock inside submitPaymentIntent makes this safe to run on
 * every instance; the overlap guard lives inside `scheduleJob`.
 */
export function startPaymentIntentCron(): void {
  scheduleJob('payment-intent-confirmer', async () => {
    const res = await confirmPendingPaymentIntents();
    return {
      outcome: 'SUCCESS',
      counters: { checked: res.checked, expired: res.expired },
    };
  });
}
