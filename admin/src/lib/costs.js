/**
 * Cloudflare Stream list prices (developers.cloudflare.com/stream/pricing,
 * checked 2026-10-09): delivery $1 per 1,000 minutes delivered, storage $5
 * per 1,000 minutes stored per month. Estimates only — the Cloudflare bill is
 * the source of truth.
 */
export const DELIVERY_USD_PER_1000_MIN = 1;
export const STORAGE_USD_PER_1000_MIN_MONTH = 5;
export function deliveryCost(minutes) {
    return (Math.max(0, minutes) / 1000) * DELIVERY_USD_PER_1000_MIN;
}
/** Storage is bought in 1,000-minute blocks. */
export function storageCost(storedMinutes) {
    const blocks = Math.max(1, Math.ceil(Math.max(0, storedMinutes) / 1000));
    return blocks * STORAGE_USD_PER_1000_MIN_MONTH;
}
export function usd(amount) {
    return amount < 10 ? `$${amount.toFixed(2)}` : `$${Math.round(amount).toLocaleString('en-US')}`;
}
/** Mirrors authorize_playback(): free stops at soft ratio, free + ad-unlock at 100%. */
export function budgetLevel(todayMinutes, budget, softRatio) {
    if (!budget || budget <= 0)
        return 'off';
    if (todayMinutes >= budget)
        return 'hard';
    if (todayMinutes >= budget * softRatio)
        return 'soft';
    return 'ok';
}
