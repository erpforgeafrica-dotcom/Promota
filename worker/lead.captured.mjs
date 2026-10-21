/**
 * worker/lead.captured.mjs — the 'lead.captured' consumer.
 *
 * WHAT THE EVENT ACTUALLY MEANS
 * `leads_notify` (db/migrations/0002_leads.sql) fires AFTER INSERT on leads.
 * So 'lead.captured' means "a visitor submitted the waitlist form with a
 * fresh consent", NOT "the phone was verified".
 *
 * The previous version of this file imported a module that does not exist
 * (`./supabase.mjs`), so it could not even load, AND it stamped
 * `leads.verified_at` on capture — which would have marked a phone as
 * OTP-verified at the moment it was only written down. That is a false
 * verification, and verification is exactly the thing this product must not
 * fudge: it gates the whole points-and-payout economy.
 *
 * So this consumer does the only truthful thing available: it records that
 * the capture happened. The phone is verified later, by the OTP flow, which
 * creates a `profiles` row — that path is `api/routes.mjs` (otp/verify) and
 * the `auth.users` table, not this table.
 */
import * as sb from '../api/supabase.mjs';

/**
 * Consume one 'lead.captured' event.
 *
 * Returns a small report so the caller can log it. It writes nothing: the
 * row already exists (the trigger fired after the insert) and no field of it
 * may be advanced on the strength of a capture.
 */
export async function consumeLeadCaptured(payload) {
  const leadId = payload?.lead_id || payload?.leadId;
  if (!leadId) return { consumed: false, reason: 'the event carries no lead id' };

  const rows = await sb.select('leads', `id=eq.${leadId}&select=id,lane,referral_code,verified_at`);
  const lead = rows?.[0];
  if (!lead) return { consumed: false, reason: 'the lead no longer exists' };

  console.log(
    `[lead-captured] lead ${lead.id} captured for the ${lead.lane} lane`
    + ` (code ${lead.referral_code}); phone verification happens in the OTP flow`
  );
  return { consumed: true, leadId: lead.id, lane: lead.lane, verified: Boolean(lead.verified_at) };
}

// The worker interface expected by the background job runner looks for a
// `consume()` function that receives the event payload.
export const consume = consumeLeadCaptured;
