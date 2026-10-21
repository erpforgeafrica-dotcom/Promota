/**
 * data.mjs — mobile data bundle facade (MTN / Glo / Airtel / 9mobile).
 *
 * The old open blocker lives here no more: what used to be a single refused
 * adapter is now the stable worker seam over the multi-provider manager. The
 * manager owns provider order and the failover matrix (pending stays parked,
 * UNKNOWN never switches, rejections fall through, success is attributed):
 *
 *   providers/dataManager.mjs → twenty5 → vtung → legacy DATA_PROVIDER_*
 *
 * The contract the worker sees is deliberately unchanged:
 *   deliver({ network, phone, planCode, reference }) ->
 *     { ok: true, provider, providerRef, deliveredAt }
 *     { ok: false, pending: true, provider, providerRef, retryable: true }
 *     { ok: false, retryable, error, provider }
 */
import * as manager from './dataManager.mjs';

export const configured = manager.anyConfigured;
export const status = manager.status;
export const plans = manager.plans;
export const deliver = manager.deliver;
export const recheck = manager.recheck;
