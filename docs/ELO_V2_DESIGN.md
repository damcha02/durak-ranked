# Elo V2: a rating formula that depends on table size

Status: **approved (K = 20, shared losses split in proportion to (1 − p)); implemented behind a disabled switch.**
Production is unchanged: V2 is neither deployed nor active, and no rating has been recalculated.

## 1. What the code does today (V1)

The only place ratings are calculated is `private.rebuild_mode(mode)` in
`supabase/migrations/202610240002_logic.sql`. `src/rating.ts` is a TypeScript copy of it
used only by `tests/rating.test.ts`. The app never imports it.

| Caller | When |
|---|---|
| `private.finish_game` | every confirmed or tied result (`cast_vote`, `advance_expired`, `respond_to_tie`, and a re-vote after `restart_unresolved`) |
| `public.vote_reversal` | an approved correction (the game becomes `void`) |

`rebuild_mode` always does a **full replay** of one mode:

1. Takes the advisory lock `durak-rating-<mode>`.
2. Deletes every `rating_ledger` row for the mode and sets every rating in the mode back to 1200 / 0 / 0.
3. Goes through every round of that mode that has at least one `confirmed` or `tied` game, in `started_at, id` order.
4. Within each round it handles games in `slot` order. Every game reads `public.ratings`, which is not updated until the round ends, so **both parallel games use the ratings from the start of the round.**
5. Uses `n = count(round_players)`. Every round player takes part in every game of the round, which is how the votes work.
6. Gain for each loser/winner pair: `mult·32/(n−1)·(1−E_wL)`, with `mult = 0.5` when `state='tied'`.
7. The ledger has one row per (game, participant), `recorded_at = finalized_at`. `games` counts rated games in the round and `losses` counts `user = any(loser_ids)`.

`void`, `unresolved`, `awaiting`, `voting` and `tie_offer` games are skipped. Rejected or expired
corrections leave the game `confirmed`, so it still counts. The documentation matches the SQL.

### Findings that affect the migration

* **F1. Changing `rebuild_mode` changes all of history at once, without anyone asking for it.**
  The next finished game in a mode replays that mode's entire history with the new formula,
  while modes with no new games stay on V1. So V2 must not take effect when its migration is
  applied. It has to be switched on explicitly and replay all four modes in one transaction (Phase C).
* F2. The winner loop has no `ORDER BY`, so floating-point additions can happen in any order
  (differences around 1e-13). There is no rounding either. V2 fixes both.
* F3. A game that was reopened (`restart_unresolved`) and then confirmed gets `recorded_at = now()`,
  but it is replayed at its round's original start. The profile's "rating over time" chart sorts by
  `recorded_at`, so it can show that game out of order. This is a display issue only, and V2 does not change it.
* F4. The deployed function bodies have not been checked yet. Phase C step 1 will compare
  `pg_get_functiondef` on production against these migrations, read-only.

## 2. Candidate formulas

Notation: n players, ratings R_i, loser set T (|T| = m; m = 1 is a sole loss).

**V1 (current):** pairwise loser vs. each winner, K/(n−1) per pair. An equally rated loser always gets −K/2 = −16.

**Candidate A, the "Durak-probability" (Plackett–Luce last-place) model. Recommended.**

```
γ_i = 10^(−R_i/400)            weaker player → larger γ
p_i = γ_i / Σ_j γ_j            the model's chance that i ends up the Durak (Σ p = 1)
sole loser L : ΔR_L = −K·(1 − p_L)      each winner: ΔR_i = +K·p_i
```

* With n = 2 this is exactly standard Elo.
* It is the gradient of the log-likelihood of "L was the loser", which is the standard
  multiplayer extension of Elo, not a hand-tuned penalty. With equal ratings p = 1/n, so a
  sole loser gets −K(n−1)/n: **the fewer the players, the smaller the loss.**
* Zero-sum exactly: Σ_winners K·p_i = K·(1 − p_L).
* A loser can never lose more than K, and a winner never loses points.
* Easy to explain: "You had a 25% chance of being the Durak. You were, so you lose 20 × 75% = 15."

**Candidate B: V1 pairwise, scaled by table size.** Gain per pair is `2K/n·(1−E_wL)`, which equals V1 × (n−1)/n × 2K/32.
It gives the same results as A when ratings are equal and keeps V1's strong dependence on the
loser's rating. In effect it is V1 times a fixed size factor, and the most a loser can lose grows
with n (up to ~2K).

**Candidate C: full pairwise, with winners counted as drawing each other.** This was rejected:
when ratings are equal, the winner-vs-winner terms cancel and the loser gets −K/2 regardless of n,
which is the same problem V1 has.

Both A and B have **zero expected drift** for a correctly rated player under the Luce model,
at every table size (checked numerically). Neither is biased in itself. They differ in how they
behave and how much their results vary.

### Shared (accepted tie) losses under A

Winners always receive +K·p_i. The tied group together loses K·(1 − P_T), where P_T = Σ_{t∈T} p_t
is the chance that the Durak is one of them. This total is the same for every reasonable way of
splitting it. Recommended split, the **same rule as a sole loss**:

```
ΔR_t = −K·(1 − P_T)·(1 − p_t) / Σ_{s∈T}(1 − p_s)
```

* With m = 1 it gives exactly the sole-loss formula.
* It is never positive.
* With equal ratings everyone pays the same share.
* The stronger tied player pays more, as in V1.

Alternatives considered:
* (A-c) Count a shared loss as 1/m of a loss, like a chess draw: ΔR_t = K(p_t − 1/m). This is purely
  gradient-based, but a heavy underdog in a tie can *gain* points, which contradicts the in-app
  text "each loses less rating".
* (A-a) The exact likelihood of "the loser is in T". Here the *weaker* tied player bears most of the
  loss (for example −6.6 vs −0.7 in the 4-player mixed tie below), the opposite of V1.

### K

Every number scales linearly with K. **K = 20 is recommended.** A 5-player game stays at today's
−16, smaller tables lose less, and the typical swing per game stays close to V1
(SD at 3/4/8/16 players: V1 11.3/9.2/6.0/4.1 → V2 9.4/8.7/6.6/4.8). With K = 24 a 3-player game
stays at −16. With K = 32 every loss gets bigger.

## 3. Worked examples (K = 20)

### Equal ratings, sole loser

| Players | V1 loser | V1 each winner | **V2 loser** | **V2 each winner** | p (chance of losing) |
|---|---|---|---|---|---|
| 3 | −16.00 | +8.00 | **−13.33** | +6.67 | 33.3% |
| 4 | −16.00 | +5.33 | **−15.00** | +5.00 | 25.0% |
| 5 | −16.00 | +4.00 | **−16.00** | +4.00 | 20.0% |
| 6 | −16.00 | +3.20 | **−16.67** | +3.33 | 16.7% |
| 8 | −16.00 | +2.29 | **−17.50** | +2.50 | 12.5% |
| 16 | −16.00 | +1.07 | **−18.75** | +1.25 | 6.25% |

### Equal ratings, accepted shared loss

Ties need at least 2 votes per candidate, so m ≤ n/2 and there are none at 3 players.

| Players | Tied | V1 each tied | V1 each winner | V2 each tied | V2 each winner |
|---|---|---|---|---|---|
| 4 | 2 | −5.33 | +5.33 | −5.00 | +5.00 |
| 5 | 2 | −6.00 | +4.00 | −6.00 | +4.00 |
| 6 | 2 | −6.40 | +3.20 | −6.67 | +3.33 |
| 6 | 3 | −4.80 | +4.80 | −3.33 | +3.33 |
| 8 | 2 | −6.86 | +2.29 | −7.50 | +2.50 |
| 8 | 4 | −4.57 | +4.57 | −2.50 | +2.50 |
| 16 | 2 | −7.47 | +1.07 | −8.75 | +1.25 |

### Mixed skill (loser listed first)

| Game | V1 | **V2 (A)** | B |
|---|---|---|---|
| 4p: 1400 loses to 1200 ×3 | −24.3 / +8.1 ×3 | **−18.1 / +6.0 ×3** | −22.8 / +7.6 ×3 |
| 4p: 1000 loses to 1200 ×3 | −7.7 / +2.6 ×3 | **−9.7 / +3.2 ×3** | −7.2 / +2.4 ×3 |
| 4p: 1200 loses to 1400, 1300, 1100 | −13.2 / +2.6 / +3.8 / +6.8 | **−14.5 / +1.7 / +3.1 / +9.7** | −12.4 / +2.4 / +3.6 / +6.4 |
| 4p: 1200 loses to 1000, 1100, 1100 | −21.8 / +8.1 / +6.8 / +6.8 | **−17.4 / +8.2 / +4.6 / +4.6** | −20.4 / +7.6 / +6.4 / +6.4 |
| 3p: 1300 loses to 1200, 1100 | −22.4 / +10.2 / +12.2 | **−16.6 / +6.0 / +10.6** | −18.7 / +8.5 / +10.1 |
| 3p: 1100 loses to 1300, 1200 | −9.6 / +3.8 / +5.8 | **−9.4 / +3.4 / +6.0** | −8.0 / +3.2 / +4.8 |
| 8p: 1500 loses to 1200 ×7 | −27.2 / +3.9 ×7 | **−19.5 / +2.8 ×7** | −29.7 / +4.2 ×7 |
| 16p: 1000 loses to 1200 ×15 | −7.7 / +0.5 ×15 | **−16.5 / +1.1 ×15** | −9.0 / +0.6 ×15 |
| 4p shared: 1400 & 1000 vs 1200, 1200 | −8.1 / −2.6 / +5.3 / +5.3 | **−5.0 / −2.3 / +3.7 / +3.7** | −7.6 / −2.4 / +5.0 / +5.0 |
| 6p shared: 1300 & 1250 vs 1200, 1150, 1100, 1000 | −9.4 / −8.7 / +3.9 / +4.3 / +4.7 / +5.3 | **−8.6 / −8.4 / +2.3 / +3.1 / +4.1 / +7.4** | −9.8 / −9.1 / +4.0 / +4.5 / +4.9 / +5.5 |

Every row sums to 0. In V2, losing against a stronger table always costs less than losing against
a weaker one, and a weaker winner gains more than a stronger one.

**Trade-off:** in A, how much the loser's own rating matters shrinks as the table grows. In a
16-player game, a 1000 loser gets −16.5 and a 1500 loser −19.8 (V1: −7.7 / −27.2). This is correct
under the model: in a 16-player game even a weak player is unlikely to be the Durak, so every
loss is a surprise. The winners' gains still depend strongly on their ratings. If the loser's
rating should matter as much as in V1 at large tables, B does that, at the cost of losses above K
and a size multiplier.

### Several games with changing table sizes (V2, K = 20)

| Game | Loser | A | B | C | D | E | Σ |
|---|---|---|---|---|---|---|---|
| ABC | A | 1186.67 | 1206.67 | 1206.67 | 1200 | 1200 | 6000 |
| ABCD | B | 1192.06 | 1191.47 | 1211.47 | 1204.99 | 1200 | 6000 |
| ABCDE | C | 1196.24 | 1195.67 | 1195.21 | 1208.88 | 1204.00 | 6000 |
| ABC | C | 1202.89 | 1202.34 | 1181.90 | 1208.88 | 1204.00 | 6000 |
| ABCDE | A | 1186.82 | 1206.28 | 1186.33 | 1212.67 | 1207.90 | 6000 |

## 4. Can players gain by choosing a table size?

* **Expected change is zero at every n** for a correctly rated player (Σ over outcomes p_L·ΔR = 0).
  Choosing a size gives no systematic advantage.
* **Variance:** the swing per game, K·√(p(1−p)), is larger at small tables. A leader who wants to
  protect a high rating could prefer large tables or avoid playing. V1 already has this, more
  strongly (V1's swing drops 2.8× from 3 to 16 players, V2's 1.9×). V2 also caps any single loss
  at K = 20, where V1 can take 27+ from a strong player, which reduces the reason to avoid weak tables.
* **Misrated players** move to their correct rating fastest at small tables. That is quicker
  convergence, not a profit: someone who is underrated gets there at any table size.
* **Padding the table** with an account that loses on purpose transfers K·p_i to each winner. This
  stops working on its own as that account's rating falls (p_L → 1, loss → 0), as in V1. The real
  protection is that the loser is chosen by majority vote.
* **Fake ties:** a tie needs every tied player to accept and gives winners the same amount as a
  sole loss. Agreeing to a tie only moves points within the tied group.
* Mode isolation is unchanged: every mode is replayed on its own and only reads its own ratings.

## 5. Implementation (Phase B)

Migration `supabase/migrations/202610260001_elo_v2.sql` (forward-only; earlier migrations untouched):

* `private.rating_config`: one row, `formula` = `'v1'` (default) or `'v2'`, `k` = 20. Not readable by browser roles.
* `private.rebuild_mode` is now a dispatcher. The deployed V1 function is **renamed** to
  `private.rebuild_mode_v1` rather than rewritten, so its body stays exactly as deployed.
  `finish_game` and `vote_reversal` keep calling `private.rebuild_mode`. While the switch is `'v1'`,
  applying the migration changes nothing (F1), and a test checks this.
* `private.elo_v2_game_deltas(players, ratings, losers, k, tiebreak)`: the pure per-game formula, in `numeric`.
  Rounding: deltas in whole cents, using largest remainders, so every game sums to exactly 0.00. Raw
  values are snapped to 1e-9 cents first, so equal ratings give exact ties. Ties are ordered by
  `md5(game_id || user_id)`: the result is deterministic, but the spare cent doesn't always go to
  the same users, as it would with plain `user_id` order.
* `private.elo_v2_replay(mode, k)`: a V2 replay of one mode into temp tables only. It uses the same
  semantics as V1: rounds in `(started_at, id)` order, only `confirmed`/`tied` games, the full
  locked roster plays every game, and every game of a round is rated from the start-of-round ratings.
  It aborts (and so rolls back) on invalid history.
* `private.rebuild_mode_v2(mode)`: the same advisory lock as V1, then rewrites the ledger and ratings for that mode.
* `private.elo_v2_preview(mode)`: a read-only comparison of current vs. V2 per player, with ranks.

`src/rating.ts` is the TypeScript reference (V1 and V2). It reproduces the SQL to the cent.

Tests (`npm test`): `tests/rating.test.ts` covers the formula. `tests/eloV2.sql.test.ts` loads the
real migrations into PGlite (Postgres 18 in-process; production is 17, and `numeric` behaves the
same in both) and drives the real RPCs: votes, ties, corrections and reopening unresolved games.
`tests/eloV2.dryrun.test.ts` covers the Phase C dry-run pipeline. Not covered: concurrent sessions
(PGlite has a single connection). The advisory lock and row locks are the same as in V1.

## 6. Phase C dry run (read-only)

1. Export (reads production; cannot write; no e-mails or auth data):
   ```
   mkdir -p scripts/elo-v2/out
   psql "postgresql://postgres.<project-ref>@<pooler-host>:5432/postgres" \
     -X -q -At -v ON_ERROR_STOP=1 -f scripts/elo-v2/export.sql -o scripts/elo-v2/out/export.jsonl
   ```
2. Replay locally: `node scripts/elo-v2/run.ts`. This writes `scripts/elo-v2/out/report.md` and `report.csv` (gitignored).

The report checks:
* that Elo V2 is not installed in production yet (no `elo_v2_*` or `rebuild_mode_v1` functions);
* the deployed functions against migrations 0001–0005 (drift);
* that the history is valid input for a replay;
* the shape of the stored ledger;
* that the stored ratings equal a fresh V1 replay;
* that the preview wrote nothing;
* a rehearsed activation on the local copy: all game records unchanged, same ledger keys, exactly
  zero-sum in whole cents, preview equals the result, the replay is idempotent, and switching back to V1 restores today's ratings.

Then it lists every player per mode: current vs. V2 rating, change, games, losses, and old vs. new rank.

## 7. Decisions (resolved)

1. Formula A, K = 20.
2. Shared losses are split in proportion to (1 − p).
3. In Single Double and Double Double, every participant plays both physical games, so n is the full locked round roster for both.
