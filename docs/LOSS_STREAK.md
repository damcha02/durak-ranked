# Losing-streak penalty (rule `loss_streak_v1`)

Status: **implemented behind a disabled switch.** Applying the migration changes no rating, ledger value
or game. The rule takes effect only when `scripts/loss-streak/activate.sql` is run with `-v commit=on`.

## The rule

A player has one consecutive-loss count per mode, shared by every table of that mode.

* Every rated game (`confirmed` or `tied`) is a **loss** for each player in `loser_ids` and a **win** for
  everyone else at the table. A loss adds 1 to the count. A win sets it to 0.
* A shared loss (an accepted tie) is a loss for every tied player, and each uses their own count.
* Unresolved, void and still-running games are not rated, so they leave the count alone.
* Games are counted one at a time in replay order: rounds by `(started_at, id)`, games by slot.
  So Game 1 of a parallel round moves the count before Game 2. Both games are still rated from the
  start-of-round snapshot, as before.
* Losses 1–3 cost plain Elo V2. **From the 4th loss in a row on, a loss costs 25% more**, and keeps
  costing 25% more until the player wins.

K = 20 and the 400 rating scale are unchanged.

### The amounts

1. Compute the normal V2 result for the game (`private.elo_v2_game_deltas`), in whole cents.
2. Each penalized loser's delta is multiplied by 1.25.
3. The extra (25% of each penalized loser's normal loss) goes to the winners, in proportion to their
   normal gains. A tied loser who is not on a streak pays exactly their normal amount.
4. The adjusted values are rounded to 0.01 with the same largest-remainder rule as V2. Equal
   remainders are ordered by `md5(game_id || user_id)`. Every game therefore sums to exactly 0.00.

What this guarantees: a penalized loser never pays less than normal, a winner never gains less than
normal, and a game with nobody penalized is identical to plain V2. Because of rounding, a penalized
loss is 1.25 × the normal loss within one cent.

Example (4 players, all 1200): a normal loss is −15.00 and each winner gains +5.00. A 4th loss in a row
costs −18.75, and each winner gains +6.25.

## Activation point and history

`private.rating_config` gains `streak_rule` (`'off'` | `'loss_streak_v1'`) and `streak_from`
(the activation time). A constraint requires that `streak_from` is set exactly when the rule is on.

* The rule covers only rounds **started at or after `streak_from`**. Earlier rounds keep plain V2 and never
  touch any count, so every count is 0 at activation.
* Rounds are replayed in `started_at` order, so all covered rounds come after all older ones. No replay
  (after a correction, a reopened vote, or a manual rebuild) can apply the penalty to an older game, or
  let an older game start a streak.
* A round that was already running when the rule was activated is "before activation", even if its
  result comes in later. So is an old unresolved vote that is reopened later.
* Corrections and reopened votes are handled by the existing full replay: voiding a loss or a win
  recalculates every later streak and penalty in that mode.
* Under V1 (`formula='v1'`) the rule is ignored, and the dispatcher sets every `loss_streak` back to 0.

## Data

| Where | What |
|---|---|
| `public.ratings.loss_streak` | the current count per player and mode (0 while the rule is off) |
| `public.rating_ledger.streak_extra` | the part of `delta` that comes from the penalty: negative for the penalized loser, positive for the winners' shares, otherwise 0 |
| `public.rating_ledger.loss_streak` | the player's count after this game; NULL for games the rule does not cover |
| `public.my_game_history` | adds `loss_streak`, `streak_extra` (the caller's own) and `streak_penalty` (true if anyone at the game was penalized) |
| `public.game_details` | adds `streak_penalty`, plus each player's `loss_streak` and `streak_extra` |

`delta` stays the real change, penalty included. The History running balance and Profile read the ledger
as before, so they show the actual amounts.

`ratings` is readable by every signed-in user, so other players can see each other's current streak
(games and losses were already visible to everyone).

## Code

Migration `supabase/migrations/202610290001_loss_streak_penalty.sql`:

* `private.elo_streak_game_deltas(players, ratings, losers, k, tiebreak, penalized)`: the per-game formula.
* `private.elo_v2_replay` (replaced, same signature and temp tables plus streak columns): it keeps the
  count and applies the rule to covered rounds. With the rule off, it produces exactly what the
  previous version did (tested on production-shaped history).
* `private.rebuild_mode_v2` writes the new columns. It takes the same per-mode advisory lock, which
  also serializes streaks across tables.
* `private.rebuild_mode`: under V1 it also clears streaks.
* `my_game_history` (recreated, because its return type changed) and `game_details` gain the streak fields.

TypeScript reference: `streakDeltas` in `src/rating.ts`. It reproduces the SQL to the cent. UI labels
live in `src/lossStreak.ts`.

## Tests (`npm test`)

* `tests/lossStreak.test.ts` (PGlite, real migrations and RPCs) covers:
  * losses 1–3 plain and the 4th+ at 1.25×
  * a win resets the count; modes are independent; streaks carry across tables
  * unresolved games are ignored; shared losses (one or both tied players on a streak)
  * Single Double and Double Double, including both games coming from the start-of-round snapshot
  * voided losses and voided wins, rejected corrections, reopened votes
  * deterministic replay; 90 random rounds against the TypeScript replay, across the activation point
  * 300 random games of the per-game formula, exactly zero-sum
  * the migration is a no-op with the rule off; older games are kept and counts start at 0 at activation
  * History balance across the activation point; History and details fields; grants
* `tests/lossStreak.activation.test.ts`: activation and restore scripts. Covers rehearsal, commit,
  refusals, rollback when a check fails, exact restore, restore after new games, and that the status
  script is read-only.
* `tests/lossStreak.concurrency.test.ts` (real PostgreSQL, set `DURAK_TEST_PG_URL`) covers:
  * two games of the same mode at different tables finishing at once: the penalty lands on the 4th loss
    in replay order, whichever commits first
  * a correction and a new loss finishing at once
  * 24 games finishing concurrently across 4 tables

  In every case the stored state equals a fresh serial replay.
* `tests/lossStreakLabel.test.ts`: the Profile/History labels.

The scripts were also run with real `psql` against PostgreSQL 17.11: rehearsal, activation, refusal of a
second activation, status, restore rehearsal and restore.

## Deployment (each step needs explicit approval; nothing here has been run on production)

Use the same connection string as for the Elo V2 scripts; psql prompts for the password. Pick a moment
when nobody is playing.

1. **Check the state:** `psql "<connection>" -X -f scripts/elo-v2/status.sql`. `formula` must be `v2`.
2. **Apply the migration.** Production already has `202610290002_rating_history.sql`, so the earlier-numbered
   streak migration needs `--include-all` (plain `db push` refuses a file older than the newest applied one).
   Run `npx supabase db push --linked --include-all --dry-run`. It must list only
   `202610290001_loss_streak_penalty.sql`. Then run `npx supabase db push --linked --include-all`. The migration
   is inert, so ratings do not change. Applying it after `202610290002` gives the same schema as name order;
   `tests/integration.test.ts` checks this. Never use `migration repair` to get around an ordering error.
3. **Deploy the frontend:** `npm run build`, then the usual `wrangler pages deploy`. Until activation, every
   count is 0 and no streak UI appears.
4. **Rehearse the activation:** `psql "<connection>" -X -v ON_ERROR_STOP=1 -f scripts/loss-streak/activate.sql`.
   It must end with "All losing-streak activation checks passed" and "Rehearsal only … ROLLED BACK".
5. **Activate:** run the same command with `-v commit=on`. It:
   * takes the same locks as the V2 scripts (a 10 s lock timeout, so it changes nothing if a game is
     being finalized)
   * backs up ratings, ledger and config into the schema `loss_streak_backup` (no API grants)
   * sets `streak_rule='loss_streak_v1'` and `streak_from=now()`, then replays every mode

   Before committing, it verifies:
   * every rating and ledger delta is exactly unchanged, and every count is 0
   * no round starts at or after the activation time
   * game, account and membership tables are checksum-identical
   * an independent replay reproduces the stored state
6. **Monitor:** `psql "<connection>" -X -f scripts/loss-streak/status.sql` (read-only) shows the switch,
   the number of penalized games, the total extra Elo moved, and every non-zero streak.

## Rollback and recovery

* **Turn the rule off:** run `scripts/loss-streak/restore.sql`, first as a rehearsal, then with `-v commit=on`.
  It sets `streak_rule='off'` and replays every mode under plain V2. Games played since activation are
  kept and re-rated without the penalty, and streaks go back to 0.
  * If nothing was played since activation, the result must equal the backup exactly, or it aborts.
  * It prints every rating that changed.
  * The backup schema is kept. Drop it by hand later (`drop schema loss_streak_backup cascade`).
    Activating again is refused while it exists.
* **Frontend:** the app works with or without the migration. Missing fields count as no streak, so an
  older frontend build is safe with the new database.
* **Migration:** it is additive (columns and replaced functions). There is no automatic down-migration, and
  none is needed once the rule is off. If the code itself must be reverted, restore the previous
  `elo_v2_replay`, `rebuild_mode_v2`, `rebuild_mode`, `my_game_history` and `game_details` from
  migrations `202610260001` / `202610280001` while the rule is off. The added columns can stay.
* **Elo V2 restore (`scripts/elo-v2/restore.sql`):** it switches to V1, which ignores the rule and clears
  streaks. Ratings and rating records are never deleted. Every path is a replay of the unchanged game
  history.
