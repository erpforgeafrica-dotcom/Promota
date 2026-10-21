-- =====================================================================
-- 0016_money_flows.sql
--
-- The two money paths had no schema behind them:
--
--   MONEY IN  - fund_campaign_escrow() credited the escrow from an ADMIN
--                typing a naira amount into a prompt. There was no record
--                of a payment, no provider reference, no receipt and no
--                way to prove the money arrived. A brand could not pay.
--   MONEY OUT - a cash redemption was debited and parked as
--                'processing' forever: nothing ever called
--                flw.createTransfer(). There was also nowhere to store a
--                beneficiary account: profiles only carried bank_last4,
--                which is four digits and cannot be paid.
--
-- This migration adds the missing records:
--
--   campaign_payments - one row per collection attempt, carrying the
--                       reference WE issued, the provider transaction id,
--                       the amount we asked for, the amount actually
--                       settled, and the payment link. The Flutterwave
--                       webhook matches on provider_ref and credits the
--                       escrow with an idempotency key derived from it, so
--                       a replayed webhook cannot credit twice. The amount
--                       is re-verified against the provider before it is
--                       credited — never read from the callback body.
--
--   payout_accounts   - the beneficiary a cash payout is sent to. The
--                       account number is NEVER stored in the clear: the
--                       app layer encrypts it with AES-256-GCM
--                       (providers/payoutCrypto.mjs) and the database holds
--                       only ciphertext. The account name is verified
--                       against Flutterwave's account-resolve endpoint
--                       before any money moves.
--
-- Requires 0012 (fund_campaign_escrow), 0013.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. money in: campaign_payments
-- ---------------------------------------------------------------------
create table if not exists campaign_payments (
  id             uuid primary key default gen_random_uuid(),
  campaign_id    uuid not null references campaigns(id) on delete cascade,
  -- the reference WE issued; the provider echoes it back on the webhook.
  provider_ref   text not null unique,
  provider       text not null default 'flutterwave',
  -- the provider's own transaction id, learned from the webhook.
  provider_tx_id text,
  amount_minor   bigint not null check (amount_minor > 0),
  -- what the provider actually settled, in kobo. Set from the VERIFIED
  -- transaction, never from the webhook body alone.
  settled_minor  bigint,
  currency       char(3) not null default 'NGN',
  status         text not null default 'pending'
                   check (status in ('pending','settled','failed','refunded')),
  payment_link   text,
  paid_at        timestamptz,
  failure_reason text,
  created_by     uuid references profiles(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists campaign_payments_campaign_idx
  on campaign_payments(campaign_id, created_at desc);
create index if not exists campaign_payments_status_idx
  on campaign_payments(status);
create index if not exists campaign_payments_tx_idx
  on campaign_payments(provider_tx_id);

-- A settled payment must carry what was actually settled and when, and it
-- may never settle MORE than was asked for: a provider that sends extra is
-- not evidence that the requested amount arrived.
alter table campaign_payments drop constraint if exists campaign_payments_settled_shape;
alter table campaign_payments add constraint campaign_payments_settled_shape
  check (status <> 'settled' or (settled_minor is not null and paid_at is not null));
alter table campaign_payments drop constraint if exists campaign_payments_settled_not_over;
alter table campaign_payments add constraint campaign_payments_settled_not_over
  check (settled_minor is null or settled_minor <= amount_minor);

comment on table campaign_payments is
  'One row per collection attempt against a campaign budget. The escrow is '
  'credited only from a webhook whose amount was re-verified against the '
  'provider, never from the webhook body.';

-- ---------------------------------------------------------------------
-- 2. money out: payout_accounts
-- ---------------------------------------------------------------------
create table if not exists payout_accounts (
  id             uuid primary key default gen_random_uuid(),
  profile_id     uuid not null references profiles(id) on delete cascade,
  bank_code      text not null,
  bank_name      text not null,
  -- AES-256-GCM ciphertext, produced by providers/payoutCrypto.mjs. The
  -- clear account number never reaches the database.
  account_number_enc text not null,
  -- the name Flutterwave says belongs to the account. Stored encrypted too,
  -- because a payout name is personal data.
  account_name_enc   text not null,
  -- the last four digits, in the clear, so the promoter can recognise their
  -- own account without the server decrypting on every read. Four digits
  -- identify nothing on their own.
  account_last4 text not null check (account_last4 ~ '^[0-9]{4}$'),
  -- the name the promoter claims, for the reviewer to compare.
  claimed_name  text not null,
  legal_name    text not null,
  -- set when Flutterwave's account-resolve confirmed the account number
  -- belongs to the claimed name.
  verified_at   timestamptz,
  verified_by   uuid references profiles(id),
  failure_reason text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- one active payout account per promoter
  constraint payout_accounts_one_per_profile unique (profile_id)
);

comment on table payout_accounts is
  'Beneficiary bank details for a cash payout. The account number and the '
  'resolved account name are stored ONLY as ciphertext (AES-256-GCM). A '
  'payout may not be sent to an unverified row.';

alter table payout_accounts drop constraint if exists payout_accounts_verified_shape;
alter table payout_accounts add constraint payout_accounts_verified_shape
  check (verified_at is not null or failure_reason is not null);

-- ---------------------------------------------------------------------
-- 3. RLS - private by default
-- ---------------------------------------------------------------------
alter table campaign_payments enable row level security;
alter table payout_accounts   enable row level security;

-- a business sees its own collection attempts
drop policy if exists campaign_payments_own_read on campaign_payments;
create policy campaign_payments_own_read on campaign_payments
  for select to authenticated
  using (exists (select 1 from campaigns c
                  where c.id = campaign_payments.campaign_id
                    and c.owner_id = auth.uid()));

-- A promoter does NOT read payout_accounts directly. The row holds
-- ciphertext and personal data; the API returns only the bank name, the
-- last four digits and the verification state, so the browser is given no
-- reason to hold the row at all.
drop policy if exists payout_accounts_own_read on payout_accounts;

-- finance and admin read everything (read-only; writes go through the
-- service-role API, which is the only writer of money-adjacent rows).
-- The permission keys are the RBAC model's own, so a custom role cannot
-- smuggle power by being called "support".
drop policy if exists campaign_payments_admin_read on campaign_payments;
create policy campaign_payments_admin_read on campaign_payments
  for select to authenticated
  using (has_perm('ledger.read'));

drop policy if exists payout_accounts_admin_read on payout_accounts;
create policy payout_accounts_admin_read on payout_accounts
  for select to authenticated
  using (has_perm('payout.execute'));

-- ---------------------------------------------------------------------
-- 4. grants - the browser never writes these tables
-- ---------------------------------------------------------------------
revoke all on campaign_payments from public, anon, authenticated;
revoke all on payout_accounts   from public, anon, authenticated;
-- campaign_payments carries no secret: a business may read its own rows
-- through the RLS policy above.
grant select on campaign_payments to authenticated;
-- payout_accounts is NOT granted to the browser at all: the API serves the
-- non-secret fields, so there is nothing for the browser to fetch directly.
grant all on campaign_payments to service_role;
grant all on payout_accounts   to service_role;

-- ---------------------------------------------------------------------
-- 5. settings - the naira value of a point
--
-- A cash redemption spends POINTS; the bank needs NAIRA. The rate is a
-- platform setting (owner-tunable through the admin settings screen), not a
-- constant buried in code: 200 bp = 200/10000 = N0.02 per point, so the
-- seeded 10,000-point minimum redemption is N200.
-- ---------------------------------------------------------------------
insert into settings (key, value, value_type, label, group_name)
values ('redemption.cash_rate_bp',
        '{"v":200}'::jsonb, 'int',
        'Naira value of one point, in basis points of a naira (200 = N0.02 per point)',
        'redemption')
on conflict (key) do nothing;
