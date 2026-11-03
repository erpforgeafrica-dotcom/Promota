-- =====================================================================
-- 0020_mutual_promotion.sql  --  "Promote You": members promote each other
--
-- WHY THIS FILE EXISTS
-- Promota already lets a brand fund a campaign and a promoter do the work.
-- What it did not have is the simplest promise of the product's own name:
-- a member can put THEMSELVES up for promotion, and another member promotes
-- them back. You promote me, I promote you -- both sides do real, disclosed
-- distribution work on their own accounts, and both sides are paid in points.
--
-- This is NOT paid engagement. Every delivery is a piece of original,
-- disclosed distribution (the same `distribution` class migration 0018
-- allows): the member publishes brand-supplied or self-supplied content on
-- their own channel with the platform's branded-content disclosure. No likes,
-- follows, views or comments are bought anywhere in this module.
--
-- THE RULES, ENFORCED IN POSTGRES
--   R1  A card is a member's own offer. Only the owner may create it.
--   R2  A pair is always two DIFFERENT members and two DIFFERENT cards.
--   R3  Only the invited member can accept a pair; only participants act.
--   R4  Each side promotes the OTHER member's card, never their own.
--   R5  One delivery per side per pair; a delivery needs an https post URL,
--       a named platform and a disclosure.
--   R6  Points are minted only here, in Postgres, idempotently:
--         promotion_reward -> once per approved delivery
--         promotion_bonus  -> once per member when BOTH sides are approved
--   R7  A rejection mints nothing and never edits a prior entry; a reversal
--       is the only correction path (same law as migration 0008).
--   R8  Every review writes an append-only audit_log row.
--   R9  Caps are settings, not code: open pairs per member and invitations
--       per week are tunable without a migration.
--
-- Requires 0019 (the two point kinds) and 0008/0018 (points + policy).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. vocabulary
-- ---------------------------------------------------------------------
create type promo_card_kind as enum ('business','creator','person','cause');
create type promo_card_state as enum ('draft','review','active','paused','closed','rejected');
create type promo_pair_state as enum ('proposed','active','completed','cancelled','expired');
create type promo_delivery_state as enum ('submitted','approved','rejected');
create type promo_disclosure as enum ('ad','sponsored','paid_partnership');

-- ---------------------------------------------------------------------
-- 2. promo_cards -- what a member wants promoted about themselves
--
-- A card is self-serve but not self-approving: it starts in `review` and a
-- reviewer moves it to `active`. `link_url`/`media_url` must be https so a
-- card can never smuggle a javascript: or mixed-content URL into a channel
-- post or an admin console.
-- ---------------------------------------------------------------------
create table promo_cards (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references profiles(id) on delete cascade,
  kind          promo_card_kind not null default 'person',
  state         promo_card_state not null default 'draft',
  title         text not null,
  summary       text not null,
  link_url      text not null,
  media_url     text,
  category      text,
  city          text,
  state_code    text,
  -- a card whose content is supplied by the member still needs disclosure
  -- when it is published as promotion; a reviewer may waive it for a pure
  -- "about me" profile link.
  disclosure_required boolean not null default true,
  moderation_note text,
  approved_by   uuid references profiles(id),
  approved_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint promo_cards_title_len   check (char_length(btrim(title)) between 3 and 120),
  constraint promo_cards_summary_len check (char_length(btrim(summary)) between 10 and 600),
  constraint promo_cards_link_https  check (link_url ~* '^https://[^[:space:]]+$'),
  constraint promo_cards_media_https check (media_url is null or media_url ~* '^https://[^[:space:]]+$'),
  constraint promo_cards_category_len check (category is null or char_length(category) <= 40),
  constraint promo_cards_city_len     check (city is null or char_length(city) <= 80),
  constraint promo_cards_state_len    check (state_code is null or char_length(state_code) <= 40),
  constraint promo_cards_approval_shape
    check ((state = 'active') = (approved_at is not null)),
  unique (owner_id, link_url)
);

create index promo_cards_feed_idx on promo_cards(state, created_at desc) where state = 'active';
create index promo_cards_owner_idx on promo_cards(owner_id, created_at desc);

-- ---------------------------------------------------------------------
-- 3. promo_pairs -- the mutual agreement
--
-- profile_a always proposed; profile_b was invited. `proposed_by` records
-- the actor, so "who may accept" is derivable and cannot be confused by a
-- later re-order of the parties.
-- ---------------------------------------------------------------------
create table promo_pairs (
  id               uuid primary key default gen_random_uuid(),
  card_a_id        uuid not null references promo_cards(id) on delete restrict,
  card_b_id        uuid not null references promo_cards(id) on delete restrict,
  profile_a        uuid not null references profiles(id) on delete cascade,
  profile_b        uuid not null references profiles(id) on delete cascade,
  state            promo_pair_state not null default 'proposed',
  proposed_by      uuid not null references profiles(id),
  accepted_at      timestamptz,
  delivery_deadline timestamptz,
  completed_at     timestamptz,
  cancelled_at     timestamptz,
  cancel_reason    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint promo_pairs_two_members check (profile_a <> profile_b),
  constraint promo_pairs_two_cards   check (card_a_id <> card_b_id),
  constraint promo_pairs_proposer_is_party
    check (proposed_by in (profile_a, profile_b)),
  -- giving up before accepting must not leave a phantom deadline, and an
  -- accepted pair must always know when the work is due
  constraint promo_pairs_deadline_shape
    check ((state in ('active','completed','expired')) = (delivery_deadline is not null)),
  constraint promo_pairs_completed_shape
    check ((state = 'completed') = (completed_at is not null)),
  constraint promo_pairs_cancelled_shape
    check (cancelled_at is null or state = 'cancelled')
);

-- One open pair per two members. LEAST/GREATEST make the pair order-blind.
create unique index promo_pairs_one_open_per_pair
  on promo_pairs (least(profile_a, profile_b), greatest(profile_a, profile_b))
  where state in ('proposed','active');

create index promo_pairs_member_idx on promo_pairs(profile_a, created_at desc);
create index promo_pairs_partner_idx on promo_pairs(profile_b, created_at desc);
create index promo_pairs_due_idx on promo_pairs(delivery_deadline) where state = 'active';

-- ---------------------------------------------------------------------
-- 4. promo_deliveries -- the proof that the work was done
--
-- One row per side per pair. Promoting the other member's card is the whole
-- point, so the row carries the card it promoted and the profile that did
-- the promoting; the submit function refuses any other combination.
-- ---------------------------------------------------------------------
create table promo_deliveries (
  id             uuid primary key default gen_random_uuid(),
  pair_id        uuid not null references promo_pairs(id) on delete cascade,
  profile_id     uuid not null references profiles(id) on delete cascade,
  card_id        uuid not null references promo_cards(id) on delete restrict,
  platform       text not null,
  post_url       text not null,
  disclosure     promo_disclosure not null,
  evidence       jsonb not null default '{}'::jsonb,
  state          promo_delivery_state not null default 'submitted',
  reviewed_by    uuid references profiles(id),
  reviewed_at    timestamptz,
  reject_reason  text,
  points_awarded integer not null default 0,
  created_at     timestamptz not null default now(),
  constraint promo_deliveries_one_per_side unique (pair_id, profile_id),
  constraint promo_deliveries_platform_valid
    check (platform in ('instagram','tiktok','x','facebook','youtube','whatsapp','telegram','linkedin','other')),
  constraint promo_deliveries_url_https check (post_url ~* '^https://[^[:space:]]+$'),
  constraint promo_deliveries_evidence_object check (jsonb_typeof(evidence) = 'object'),
  constraint promo_deliveries_points_nonnegative check (points_awarded >= 0),
  constraint promo_deliveries_reject_reason
    check (state <> 'rejected' or char_length(btrim(coalesce(reject_reason, ''))) >= 3),
  constraint promo_deliveries_review_shape
    check ((state = 'submitted') = (reviewed_at is null))
);

create index promo_deliveries_pair_idx on promo_deliveries(pair_id);
create index promo_deliveries_queue_idx on promo_deliveries(created_at) where state = 'submitted';

-- ---------------------------------------------------------------------
-- 5. settings -- every number is owner-tunable
-- ---------------------------------------------------------------------
insert into settings (key, value, value_type, label, group_name) values
  ('promotion.delivery_points',        '{"v":100}'::jsonb, 'int',
   'Points for one approved promotion delivery','promotion'),
  ('promotion.mutual_bonus_points',    '{"v":250}'::jsonb, 'int',
   'Extra points each member gets when both sides of a pair deliver','promotion'),
  ('promotion.max_active_pairs',       '{"v":3}'::jsonb,   'int',
   'Open promotion pairs one member may hold at once','promotion'),
  ('promotion.max_proposals_per_week', '{"v":10}'::jsonb,  'int',
   'Promotion invitations one member may send in 7 days','promotion'),
  ('promotion.delivery_window_hours',  '{"v":72}'::jsonb,  'int',
   'Hours each side has to deliver after a pair is accepted','promotion'),
  ('promotion.max_cards_per_member',   '{"v":5}'::jsonb,   'int',
   'Cards one member may hold in review or active','promotion')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- 6. helpers
-- ---------------------------------------------------------------------
create or replace function promo_setting_int(p_key text, p_default integer)
returns integer language sql stable set search_path = public as $$
  select coalesce((select (s.value->>'v')::integer from settings s where s.key = p_key), p_default)
$$;

-- Reviewer gate. Deliberately reads the role/permission tables instead of
-- auth.uid(): the API is the trusted service-role writer and passes the
-- verified session id explicitly, so the same function is testable under
-- PGlite without a JWT and cannot be widened by a caller-supplied role.
create or replace function assert_promo_reviewer(p_actor uuid) returns void
language plpgsql stable set search_path = public as $$
declare v_role app_role; v_state user_state;
begin
  select role, state into v_role, v_state from profiles where id = p_actor;
  if v_role is null then
    raise exception 'reviewer not found' using errcode = 'insufficient_privilege';
  end if;
  if v_state <> 'active' then
    raise exception 'reviewer is not active' using errcode = 'insufficient_privilege';
  end if;
  if v_role in ('support','admin','owner') then
    return;
  end if;
  if exists (
    select 1 from user_permissions up
     where up.user_id = p_actor and up.perm = 'task.review'
       and (up.expires_at is null or up.expires_at > now())
  ) then
    return;
  end if;
  raise exception 'missing task.review permission' using errcode = 'insufficient_privilege';
end;
$$;

create or replace function promo_participant(p_pair uuid, p_actor uuid) returns uuid
language plpgsql stable set search_path = public as $$
declare v_a uuid; v_b uuid;
begin
  select profile_a, profile_b into v_a, v_b from promo_pairs where id = p_pair;
  if v_a is null then
    raise exception 'promotion pair not found' using errcode = 'no_data_found';
  end if;
  if p_actor = v_a then return v_b; end if;
  if p_actor = v_b then return v_a; end if;
  raise exception 'you are not part of this promotion pair' using errcode = 'insufficient_privilege';
end;
$$;

-- A card is only as good as the account behind it, and the owner-tunable
-- card cap has to hold no matter which path inserts the row. A new card can
-- enter in draft or review only: it can never be born active.
create or replace function guard_promo_card_insert() returns trigger
language plpgsql set search_path = public as $$
declare v_state user_state; v_phone timestamptz; v_open integer; v_cap integer;
begin
  if new.state not in ('draft','review') then
    raise exception 'a new promotion card starts in draft or review, never %', new.state;
  end if;

  select state, phone_verified_at into v_state, v_phone from profiles where id = new.owner_id;
  if v_state is null then
    raise exception 'the card owner was not found' using errcode = 'foreign_key_violation';
  end if;
  if v_state <> 'active' or v_phone is null then
    raise exception 'a promotion card needs an active, phone-verified member';
  end if;

  v_cap := promo_setting_int('promotion.max_cards_per_member', 5);
  select count(*) into v_open from promo_cards
   where owner_id = new.owner_id and state in ('review','active');
  if v_open >= v_cap then
    raise exception 'you already hold % cards in review or active (limit %)', v_open, v_cap;
  end if;

  return new;
end;
$$;

drop trigger if exists promo_cards_insert_guard on promo_cards;
create trigger promo_cards_insert_guard
  before insert on promo_cards
  for each row execute function guard_promo_card_insert();

-- A delivery row must, no matter which path writes it, belong to a member of
-- the pair and promote the OTHER member's card. The submit function checks
-- this too; the trigger is what stops a direct service-role insert.
create or replace function guard_promo_delivery_insert() returns trigger
language plpgsql set search_path = public as $$
declare
  v_pair promo_pairs;
  v_expected uuid;
begin
  select * into v_pair from promo_pairs where id = new.pair_id;
  if not found then
    raise exception 'promotion pair not found' using errcode = 'foreign_key_violation';
  end if;
  if v_pair.state <> 'active' then
    raise exception 'this promotion pair is not active (state %)', v_pair.state;
  end if;
  if new.profile_id not in (v_pair.profile_a, v_pair.profile_b) then
    raise exception 'you are not part of this promotion pair'
      using errcode = 'insufficient_privilege';
  end if;

  v_expected := case when new.profile_id = v_pair.profile_a then v_pair.card_b_id else v_pair.card_a_id end;
  if new.card_id <> v_expected then
    raise exception 'a delivery must promote the partner card, not your own'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists promo_deliveries_insert_guard on promo_deliveries;
create trigger promo_deliveries_insert_guard
  before insert on promo_deliveries
  for each row execute function guard_promo_delivery_insert();

-- The points law extended to the two new kinds: a promotion reward can only
-- ever be a positive amount, exactly like a task or referral reward.
alter table point_entries add constraint point_entries_promotion_positive
  check (kind not in ('promotion_reward','promotion_bonus') or points > 0);

-- ---------------------------------------------------------------------
-- 7. card moderation
-- ---------------------------------------------------------------------
create or replace function review_promo_card(
  p_card uuid, p_actor uuid, p_approve boolean, p_note text default null
) returns text
language plpgsql set search_path = public as $$
declare v_state promo_card_state; v_owner uuid;
begin
  perform assert_promo_reviewer(p_actor);

  select state, owner_id into v_state, v_owner from promo_cards where id = p_card for update;
  if v_state is null then
    raise exception 'promotion card not found' using errcode = 'no_data_found';
  end if;
  if v_state <> 'review' then
    raise exception 'only a card in review can be reviewed (card is %)', v_state;
  end if;

  if p_approve then
    update promo_cards
       set state = 'active', approved_by = p_actor, approved_at = now(),
           moderation_note = p_note, updated_at = now()
     where id = p_card;
  else
    update promo_cards
       set state = 'rejected', approved_by = null, approved_at = null,
           moderation_note = p_note, updated_at = now()
     where id = p_card;
  end if;

  insert into audit_log(actor_id, actor_role, action, target_type, target_id, after_state)
  values (p_actor, (select role from profiles where id = p_actor),
          case when p_approve then 'promotion.card.approve' else 'promotion.card.reject' end,
          'promo_card', p_card::text,
          jsonb_build_object('owner_id', v_owner, 'approve', p_approve, 'note', p_note));

  insert into outbox(topic, payload) values
    ('promotion.card_reviewed', jsonb_build_object(
       'card_id', p_card, 'owner_id', v_owner, 'approve', p_approve));

  return case when p_approve then 'active' else 'rejected' end;
end;
$$;

revoke execute on function review_promo_card(uuid, uuid, boolean, text) from anon, authenticated;

-- ---------------------------------------------------------------------
-- 8. propose a mutual pair
-- ---------------------------------------------------------------------
create or replace function propose_promo_pair(
  p_actor uuid, p_self_card uuid, p_partner_card uuid
) returns uuid
language plpgsql set search_path = public as $$
declare
  v_self    promo_cards;
  v_partner promo_cards;
  v_profile profiles;
  v_pair    uuid;
  v_cap     integer;
  v_week    integer;
  v_open    integer;
  v_sent    integer;
begin
  select * into v_self from promo_cards where id = p_self_card;
  if not found then
    raise exception 'your promotion card was not found' using errcode = 'no_data_found';
  end if;
  if v_self.owner_id <> p_actor then
    raise exception 'you can only offer your own promotion card' using errcode = 'insufficient_privilege';
  end if;
  if v_self.state <> 'active' then
    raise exception 'your promotion card must be approved before it can be offered';
  end if;

  select * into v_partner from promo_cards where id = p_partner_card;
  if not found then
    raise exception 'the partner promotion card was not found' using errcode = 'no_data_found';
  end if;
  if v_partner.owner_id = p_actor then
    raise exception 'you cannot promote yourself -- pick another member''s card';
  end if;
  if v_partner.state <> 'active' then
    raise exception 'the partner promotion card is not active';
  end if;

  select * into v_profile from profiles where id = v_partner.owner_id;
  if v_profile.state <> 'active' then
    raise exception 'the partner account is not active';
  end if;
  if v_profile.phone_verified_at is null then
    raise exception 'the partner account is not phone-verified';
  end if;

  v_cap := promo_setting_int('promotion.max_active_pairs', 3);
  select count(*) into v_open from promo_pairs
   where state in ('proposed','active') and (profile_a = p_actor or profile_b = p_actor);
  if v_open >= v_cap then
    raise exception 'you already hold % open promotion pairs (limit %)', v_open, v_cap;
  end if;

  -- the invited member is protected too: a popular card must not be buried
  -- under invitations it never asked for
  select count(*) into v_open from promo_pairs
   where state in ('proposed','active')
     and (profile_a = v_partner.owner_id or profile_b = v_partner.owner_id);
  if v_open >= v_cap then
    raise exception 'the partner already holds % open promotion pairs (limit %)', v_open, v_cap;
  end if;

  v_week := promo_setting_int('promotion.max_proposals_per_week', 10);
  select count(*) into v_sent from promo_pairs
   where proposed_by = p_actor and created_at > now() - interval '7 days';
  if v_sent >= v_week then
    raise exception 'weekly promotion invitation limit reached (% per 7 days)', v_week;
  end if;

  insert into promo_pairs(card_a_id, card_b_id, profile_a, profile_b, proposed_by)
  values (p_self_card, p_partner_card, p_actor, v_partner.owner_id, p_actor)
  returning id into v_pair;

  insert into outbox(topic, payload) values
    ('promotion.pair_proposed', jsonb_build_object(
       'pair_id', v_pair, 'from', p_actor, 'to', v_partner.owner_id,
       'card_a', p_self_card, 'card_b', p_partner_card));

  return v_pair;
exception
  when unique_violation then
    raise exception 'you already have an open promotion pair with this member'
      using errcode = 'unique_violation';
end;
$$;

revoke execute on function propose_promo_pair(uuid, uuid, uuid) from anon, authenticated;

-- ---------------------------------------------------------------------
-- 9. accept a pair -- starts the delivery clock
-- ---------------------------------------------------------------------
create or replace function accept_promo_pair(p_pair uuid, p_actor uuid) returns void
language plpgsql set search_path = public as $$
declare
  v_pair    promo_pairs;
  v_invitee uuid;
  v_hours   integer;
  v_state   user_state;
begin
  select * into v_pair from promo_pairs where id = p_pair for update;
  if not found then
    raise exception 'promotion pair not found' using errcode = 'no_data_found';
  end if;
  if v_pair.state <> 'proposed' then
    raise exception 'this promotion pair is not awaiting acceptance (state %)', v_pair.state;
  end if;

  v_invitee := case when v_pair.proposed_by = v_pair.profile_a then v_pair.profile_b else v_pair.profile_a end;
  if p_actor <> v_invitee then
    raise exception 'only the invited member can accept this promotion pair'
      using errcode = 'insufficient_privilege';
  end if;

  select state into v_state from profiles where id = p_actor;
  if v_state <> 'active' then
    raise exception 'the accepting account is not active';
  end if;

  if not exists (select 1 from promo_cards where id = v_pair.card_a_id and state = 'active')
     or not exists (select 1 from promo_cards where id = v_pair.card_b_id and state = 'active') then
    raise exception 'a card in this pair is no longer active';
  end if;

  v_hours := promo_setting_int('promotion.delivery_window_hours', 72);

  update promo_pairs
     set state = 'active', accepted_at = now(),
         delivery_deadline = now() + make_interval(hours => v_hours),
         updated_at = now()
   where id = p_pair;

  insert into outbox(topic, payload) values
    ('promotion.pair_accepted', jsonb_build_object(
       'pair_id', p_pair, 'accepted_by', p_actor,
       'deadline_hours', v_hours));
end;
$$;

revoke execute on function accept_promo_pair(uuid, uuid) from anon, authenticated;

-- ---------------------------------------------------------------------
-- 10. submit a delivery -- you promote THEIR card
-- ---------------------------------------------------------------------
create or replace function submit_promo_delivery(
  p_pair uuid, p_actor uuid, p_platform text,
  p_post_url text, p_disclosure promo_disclosure,
  p_evidence jsonb default '{}'::jsonb
) returns uuid
language plpgsql set search_path = public as $$
declare
  v_pair      promo_pairs;
  v_other     uuid;
  v_other_card uuid;
  v_required  boolean;
  v_id        uuid;
begin
  v_other := promo_participant(p_pair, p_actor);
  select * into v_pair from promo_pairs where id = p_pair;
  if v_pair.state <> 'active' then
    raise exception 'this promotion pair is not active (state %)', v_pair.state;
  end if;
  if v_pair.delivery_deadline is not null and now() > v_pair.delivery_deadline then
    raise exception 'the delivery window for this pair has closed';
  end if;

  -- the card to promote is the OTHER member's card, by construction
  v_other_card := case when p_actor = v_pair.profile_a then v_pair.card_b_id else v_pair.card_a_id end;

  select disclosure_required into v_required from promo_cards where id = v_other_card;
  if v_required is null then
    raise exception 'the partner promotion card was not found' using errcode = 'no_data_found';
  end if;
  if v_required and p_disclosure is null then
    raise exception 'a disclosure is required for this promotion card';
  end if;

  if p_platform is null or btrim(p_platform) = '' then
    raise exception 'a platform is required';
  end if;
  if p_post_url is null or p_post_url !~* '^https://[^[:space:]]+$' then
    raise exception 'the post URL must be an https link';
  end if;

  -- a submission is accepted only after the pair exists; this also stops a
  -- back-dated row from being slipped in before acceptance
  insert into promo_deliveries(pair_id, profile_id, card_id, platform, post_url, disclosure, evidence)
  values (p_pair, p_actor, v_other_card, lower(btrim(p_platform)), p_post_url, p_disclosure,
          coalesce(p_evidence, '{}'::jsonb))
  returning id into v_id;

  insert into outbox(topic, payload) values
    ('promotion.delivery_submitted', jsonb_build_object(
       'delivery_id', v_id, 'pair_id', p_pair, 'profile_id', p_actor,
       'card_id', v_other_card, 'platform', lower(btrim(p_platform))));

  return v_id;
exception
  when unique_violation then
    raise exception 'this member already delivered their side of the pair'
      using errcode = 'unique_violation';
end;
$$;

revoke execute on function submit_promo_delivery(uuid, uuid, text, text, promo_disclosure, jsonb) from anon, authenticated;

-- ---------------------------------------------------------------------
-- 11. review a delivery -- mints the reward and, when both sides land,
--     the mutual bonus for BOTH members
-- ---------------------------------------------------------------------
create or replace function review_promo_delivery(
  p_delivery uuid, p_actor uuid, p_approve boolean, p_reason text default null
) returns jsonb
language plpgsql set search_path = public as $$
declare
  v_del     promo_deliveries;
  v_pair    promo_pairs;
  v_points  integer;
  v_bonus   integer := 0;
  v_paid    integer := 0;
  v_bonus_paid integer := 0;
  v_other   uuid;
  v_approved integer;
  v_member  uuid;
begin
  perform assert_promo_reviewer(p_actor);

  select * into v_del from promo_deliveries where id = p_delivery for update;
  if not found then
    raise exception 'promotion delivery not found' using errcode = 'no_data_found';
  end if;

  -- replay-safe: a decision already taken is reported, never re-minted
  if v_del.state <> 'submitted' then
    return jsonb_build_object(
      'delivery_id', v_del.id, 'state', v_del.state,
      'points', v_del.points_awarded, 'replayed', true);
  end if;

  select * into v_pair from promo_pairs where id = v_del.pair_id for update;

  if not p_approve then
    if char_length(btrim(coalesce(p_reason, ''))) < 3 then
      raise exception 'a rejection needs a reason of at least 3 characters';
    end if;
    update promo_deliveries
       set state = 'rejected', reviewed_by = p_actor, reviewed_at = now(), reject_reason = p_reason
     where id = p_delivery;

    insert into audit_log(actor_id, actor_role, action, target_type, target_id, after_state)
    values (p_actor, (select role from profiles where id = p_actor),
            'promotion.delivery.reject', 'promo_delivery', p_delivery::text,
            jsonb_build_object('pair_id', v_del.pair_id, 'profile_id', v_del.profile_id,
                               'reason', p_reason));

    insert into outbox(topic, payload) values
      ('promotion.delivery_rejected', jsonb_build_object(
         'delivery_id', p_delivery, 'pair_id', v_del.pair_id,
         'profile_id', v_del.profile_id, 'reason', p_reason));

    return jsonb_build_object('delivery_id', p_delivery, 'state', 'rejected',
                              'points', 0, 'replayed', false);
  end if;

  v_points := promo_setting_int('promotion.delivery_points', 100);
  if v_points <= 0 then
    raise exception 'promotion.delivery_points must be positive';
  end if;

  insert into point_entries(profile_id, task_id, kind, points, idempotency_key, memo)
  values (v_del.profile_id, null, 'promotion_reward', v_points,
          'promo_delivery:' || p_delivery::text, 'Mutual promotion delivery approved')
  on conflict (idempotency_key) do nothing;

  if found then
    v_paid := v_points;
  else
    select points into v_paid from point_entries
     where idempotency_key = 'promo_delivery:' || p_delivery::text;
  end if;

  update promo_deliveries
     set state = 'approved', reviewed_by = p_actor, reviewed_at = now(),
         points_awarded = coalesce(v_paid, 0)
   where id = p_delivery;

  insert into audit_log(actor_id, actor_role, action, target_type, target_id, after_state)
  values (p_actor, (select role from profiles where id = p_actor),
          'promotion.delivery.approve', 'promo_delivery', p_delivery::text,
          jsonb_build_object('pair_id', v_del.pair_id, 'profile_id', v_del.profile_id,
                             'points', v_paid));

  insert into outbox(topic, payload) values
    ('promotion.delivery_approved', jsonb_build_object(
       'delivery_id', p_delivery, 'pair_id', v_del.pair_id,
       'profile_id', v_del.profile_id, 'points', v_paid));

  -- both sides approved -> the promise of the product: both get the bonus
  select count(*) into v_approved
    from promo_deliveries where pair_id = v_del.pair_id and state = 'approved';

  if v_approved >= 2 and v_pair.state <> 'completed' then
    v_bonus := promo_setting_int('promotion.mutual_bonus_points', 250);
    foreach v_member in array array[v_pair.profile_a, v_pair.profile_b] loop
      insert into point_entries(profile_id, task_id, kind, points, idempotency_key, memo)
      values (v_member, null, 'promotion_bonus', v_bonus,
              'promo_mutual:' || v_del.pair_id::text || ':' || v_member::text,
              'Both sides delivered -- mutual promotion bonus')
      on conflict (idempotency_key) do nothing;
      if found then
        v_bonus_paid := v_bonus_paid + v_bonus;
      end if;
    end loop;

    update promo_pairs
       set state = 'completed', completed_at = now(), updated_at = now()
     where id = v_del.pair_id and state = 'active';

    insert into outbox(topic, payload) values
      ('promotion.mutual_completed', jsonb_build_object(
         'pair_id', v_del.pair_id, 'bonus_points_each', v_bonus,
         'bonus_total', v_bonus_paid));
  end if;

  return jsonb_build_object(
    'delivery_id', p_delivery, 'state', 'approved', 'points', coalesce(v_paid, 0),
    'mutual_bonus_each', case when v_bonus_paid > 0 then v_bonus else 0 end,
    'mutual_bonus_total', v_bonus_paid, 'pair_state',
    (select state from promo_pairs where id = v_del.pair_id), 'replayed', false);
end;
$$;

revoke execute on function review_promo_delivery(uuid, uuid, boolean, text) from anon, authenticated;

-- ---------------------------------------------------------------------
-- 12. housekeeping -- an accepted pair that produced no approved work
--     before its deadline expires. Worker/cron may call this; it never
--     touches a pair that has a delivery waiting for review.
-- ---------------------------------------------------------------------
create or replace function expire_promo_pairs() returns integer
language plpgsql set search_path = public as $$
declare v_count integer;
begin
  update promo_pairs p
     set state = 'expired', updated_at = now()
   where p.state = 'active'
     and p.delivery_deadline < now()
     and not exists (
       select 1 from promo_deliveries d
        where d.pair_id = p.id and d.state in ('submitted','approved')
     );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function expire_promo_pairs() from anon, authenticated;

-- ---------------------------------------------------------------------
-- 13. RLS -- the security boundary for any future browser read
--
-- Reads are participant-scoped; the public feed sees active cards only.
-- Pair and delivery writes are deliberately NOT granted to anon or
-- authenticated: they must go through the functions above, which enforce
-- R1-R9. The API holds the service-role key and never forwards a client id.
-- ---------------------------------------------------------------------
alter table promo_cards      enable row level security;
alter table promo_pairs      enable row level security;
alter table promo_deliveries enable row level security;

create policy promo_cards_feed_read on promo_cards
  for select using (
    state = 'active' or owner_id = auth.uid() or has_perm('admin.access')
  );

create policy promo_cards_owner_insert on promo_cards
  for insert with check (owner_id = auth.uid() and state = 'review');

create policy promo_cards_owner_update on promo_cards
  for update using (owner_id = auth.uid() and state in ('draft','review','paused','closed'))
  with check (owner_id = auth.uid() and state in ('draft','review','paused','closed'));

create policy promo_pairs_party_read on promo_pairs
  for select using (
    profile_a = auth.uid() or profile_b = auth.uid() or has_perm('admin.access')
  );

create policy promo_deliveries_party_read on promo_deliveries
  for select using (
    profile_id = auth.uid()
    or exists (
      select 1 from promo_pairs p
       where p.id = promo_deliveries.pair_id
         and (p.profile_a = auth.uid() or p.profile_b = auth.uid())
    )
    or has_perm('admin.access')
  );

revoke insert, update, delete on promo_pairs      from anon, authenticated;
revoke insert, update, delete on promo_deliveries from anon, authenticated;
revoke insert, update, delete on promo_cards      from anon, authenticated;
grant select on promo_cards to anon, authenticated;
grant select on promo_pairs, promo_deliveries to authenticated;

comment on table promo_cards is
  'A member''s own promotion offer. Self-serve, reviewer-activated, https links only.';
comment on table promo_pairs is
  'Two members promoting each other. One open pair per pair of members, enforced by a unique index.';
comment on table promo_deliveries is
  'One disclosed distribution proof per member per pair. Points minted only by review_promo_delivery().';
