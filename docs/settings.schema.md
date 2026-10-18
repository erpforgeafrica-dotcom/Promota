# Settings Schema — Promota (OwoWorks)

All runtime settings live in the `public.settings` table and are seeded by migration `0008_points_levels.sql`. Each key is a `jsonb` column with a single `value` field (e.g. `{"v":100}`). The numeric value is extracted with `(value->>'v')::int`.

| Key | Type | Default JSON | Where it is read |
|-----|------|--------------|-----------------|
| `points.default_per_task` | `jsonb` | `{"v":100}` | `points.test.mjs` (indirectly via `levels.referral_gate_from`) |
| `points.per_referral` | `jsonb` | `{"v":150}` | `points.test.mjs` |
| `points.referred_task_bonus_bp` | `jsonb` | `{"v":2500}` | SQL function `award_task_points_networked` (migration `0012`) |
| `points.referral_qualifies_on_first_task` | `jsonb` | `{"v":true}` | SQL function `qualify_referral` |
| `levels.referral_gate_from` | `jsonb` | `{"v":4}` | SQL function `level_for`; test `points.test.mjs` |
| `levels.cash_unlock_from` | `jsonb` | `{"v":4}` | SQL function `cash_unlocked`; test `points.test.mjs` |
| `redemption.data_min_points` | `jsonb` | `{"v":500}` | SQL function `redeem_points` |
| `redemption.cash_min_points` | `jsonb` | `{"v":10000}` | SQL function `redeem_points` |
| `views.bonus_brackets` | `jsonb` | `{"v":[{"min":500,"points":50},{"min":2000,"points":100},{"min":10000,"points":200},{"min":50000,"points":400}]}` | SQL function `award_views_bonus` (migration `0012`) |
| `views.min_points` | `jsonb` | `{"v":50}` | migration `0012` (bracket floor) |
| `login.points_per_day` | `jsonb` | `{"v":10}` | SQL function `checkin` (migration `0013`) |
| `login.streak_7_bonus` | `jsonb` | `{"v":50}` | SQL function `checkin` (migration `0013`) |
| `login.streak_30_bonus` | `jsonb` | `{"v":500}` | SQL function `checkin` (migration `0013`) |
| `login.perfect_month_points` | `jsonb` | `{"v":1000}` | SQL function `checkin` (migration `0013`) |
| `login.perfect_month_data_mb` | `jsonb` | `{"v":500}` | SQL function `checkin` -> worker topic `login.perfect_month` |
| `repost.min_rating_full` | `jsonb` | `{"v":4}` | `admin.mjs` `approveTask` — rated repost floor |
| `repost.low_rating_factor` | `jsonb` | `{"v":0.5}` | `admin.mjs` `approveTask` — payout factor below the floor |

**Usage pattern (SQL example)**

```sql
select (value->>'v')::int as v
from settings
where key = 'points.default_per_task';
```

**Notes**

* All defaults are **immutable** via migration; the owner may update them from an admin UI without a new migration.
* The schema is deliberately tiny – only the keys required by the point/level/cash logic are present.
* No other part of the codebase reads a settings key that is missing from the table, so there is **no “missing setting”** at runtime.