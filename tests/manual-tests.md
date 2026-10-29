# Manual Supabase integration test script

Run against a throwaway Supabase project; **not executed as part of artifact creation**.

## Permissions

- Create Alice, Bob, Carol and Eve accounts.
- Alice creates table; Bob and Carol join; Eve does not join.
- As Eve, `select * from tables` should exclude Alice's table; `round_games` and `vote_totals` should not expose Alice's round.
- As Eve, calling `cast_vote` with the game ID fails; calling `begin_results` fails.
- As Bob, `transfer_host` fails when Alice is host.
- As Alice, `transfer_host` to Bob succeeds between games.
- Direct authenticated `insert/update/delete` on `ratings`, `round_games`, `game_votes`, and `profiles` must fail.

## Natural game

- Create Natural Durak table, 3 players. Start it: no fourth player may join while playing.
- Begin results. Alice votes for Bob -> timer starts; Bob votes for Bob -> strict majority triggers immediate finalization.
- All users start 1200, Bob becomes 1184; Alice and Carol each become 1208 (K=32).
- Table reopens for next game. Host may leave and another participant becomes host.
- Change Bob's loss to void by majority correction within 24 hours; ratings return to 1200.

## Voting edge cases

- 4-player game: 2–2 tie at deadline, each tied player accepts; shared half-weight losses are applied, zero sum.
- One tied player rejects -> runoff restricted to original tied nominees.
- 3-player game: one vote at expiry -> unresolved. Restart vote manually; timer resets with next nomination.
- A voter switches nominee; only their latest ballot counts.
- At 30-second expiry, 3-player 1–1–1 -> unresolved.
- Ensure individual votes are inaccessible via RLS until ballot finalization, while aggregated vote totals remain visible.

## Parallel game and replay

- Single Double table (3 players): begin results after both physical games finish.
- Vote Game 1; confirm it; Game 2 becomes editable; keep Game 2 unresolved.
- Game 1 rating is booked. Same player may lose both Game 1 and Game 2.
- Ratings of both parallel games should use the same rating at the round start; zero-sum overall.
- Correct Game 1 while later rounds exist; replay produces ratings consistent with deterministic chronological round order.

## Authentication and PWA

- Email/password signup/confirm/login; Google OAuth callback; Apple only when configured.
- Invite QR code scanned on another smartphone; unauthenticated user signs in and joins.
- Install PWA on iOS Safari and Android Chrome, test service-worker update flow.
- App reopened after being backgrounded >30 seconds must reconcile server-authoritative deadline.

## Pre-game losing chance

- Apply `202610270001_round_rating_snapshot.sql` before deploying the frontend (without it, the estimate is simply hidden while a round is in progress).
- Lobby with 3 players at different ratings: each row shows a tiny italic "xx.x% to lose · rating Elo" line under the name; equal ratings show equal values.
- A fourth player joins, then leaves: everyone's estimate updates within a few seconds.
- Start a Single Double round: the estimates stay the same after Game 1 is confirmed and during Game 2.
- After the round, the lobby shows estimates from the updated ratings.
- Profile → Appearance → turn off "Show losing chances": the lobby looks as before; reload keeps it off; turn it on again.

## Game history

- Apply `202610280001_game_history.sql` and `202610280002_table_expiry.sql` before deploying the frontend.
- History tab: games newest first; parallel rounds show "Game 2 of 2" above "Game 1 of 2"; "Show older games" appears after 20 games.
- The newest game's "after" value in each mode equals the rating on Home/Profile.
- Open a game: every player, the loser(s), each player's change and before → after.
- A game reversed by a correction shows "Reversed after a correction vote" and ±0.00.
- As an outsider, `select public.game_details('<game id>')` fails with "Not a participant"; `select * from rating_ledger` shows only your own games.

## Home tables (cards theme)

- With two or more open tables, the front card shows the table code and "With masha and olga" ("Just you so far" when alone); the card behind shows its players too. Swipe to see each table's players without opening it.

## Losing-streak penalty

- Apply `202610290001_loss_streak_penalty.sql`, deploy the frontend: no rating changes, no streak shown anywhere.
- Run `scripts/loss-streak/activate.sql` as a rehearsal, then with `-v commit=on`; `scripts/loss-streak/status.sql` shows `loss_streak_v1` and no streaks.
- Lose three games in a row in one mode (any tables): Profile shows "3-loss streak · next loss +25%" under that mode; History shows no penalty.
- Lose a 4th: Profile shows "4-loss streak · +25% penalty"; History tags the game, shows the extra next to the tag, and the details list each winner's share ("incl. +x.xx streak"). The game still sums to zero.
- Win once: the streak disappears from Profile. A loss in another mode starts its own count.
- Both themes: the tags and Profile notes keep the existing look.

## Table expiry

- After `db push`: no "Table expiry NOT scheduled" warning; `select jobname, schedule from cron.job` lists `durak-close-inactive-tables`.
- An idle lobby shows "Table closed due to inactivity" within an hour after 24 idle hours; joining by code or link says it closed; "Start a new … table" works.
- A table whose last vote ended without a result stays open past 24 hours; "Vote again" still works days later, and the table closes 24–25 hours after that vote is decided.
- A table left in the middle of a vote stays open; after the vote resolves it gets a fresh 24 hours.

