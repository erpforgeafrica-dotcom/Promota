-- =====================================================================
-- 0019_promotion_point_kinds.sql
--
-- WHY THIS FILE EXISTS
-- 0020_mutual_promotion.sql pays two new kinds of point reward:
--   promotion_reward  the base award for an approved promotion delivery
--   promotion_bonus   the extra award both members receive once BOTH sides
--                     of a mutual promotion pair have delivered approved work
--
-- point_kind is an enum, so the values must exist before the function that
-- mints them is created. Kept in its own migration because PostgreSQL will
-- not let a newly added enum value be used in the same transaction that adds
-- it; the migration runner applies each file as its own unit of work.
--
-- No behaviour changes here: the enum grows, nothing else.
-- =====================================================================

alter type point_kind add value if not exists 'promotion_reward';
alter type point_kind add value if not exists 'promotion_bonus';
