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
