# Architecture decision and design notes

**Decision:** Use managed Supabase Auth + PostgreSQL for a fast first deployment; host a static PWA on Cloudflare Pages. Store all game rules in database transactions (RPC/PLpgSQL). The browser only sends intentions, never computed winners or rating amounts. Keep plain SQL migrations so a later PostgreSQL migration is possible. UI and business functions are separate.

## Components

```text
 iOS / Android / desktop
         |
 React + TypeScript + Vite PWA (Cloudflare Pages)
         | public publishable key + user's JWT
         v
 Supabase Auth <-> PostgreSQL RPCs / RLS
                       |       |         |
                Tables/rounds Votes   Elo ledger + profiles
                       |       |         |
                     Realtime Postgres Changes
                       |
                  Client invalidates & refetches
```

### Database model

- `profiles`: public usernames and optional reputation bookkeeping (not a punitive signal).
- `friend_groups` / `group_members`: multiple private groups and member-scoped read policies; group code joins. Group board filters global mode scores to group members.
- `tables` / `table_members`: lobby, physical playing, sequential results; QR/link/room code; host transfer and automatic reassignment.
- `rounds` / `round_players`: immutable player snapshot at physical round start. Leaving/joining disabled during active rounds; shutting off phones does not alter membership.
- `round_games`: slot 1 or 2 (for parallel modes), state, server-authoritative voting deadline, winners implied by snapshot minus losers.
- `game_votes` / `vote_totals`: ballots protected by RLS until result is final; public tallies available to the round participants.
- `tie_responses`: acceptance of reduced shared loss, or a constrained runoff; tie response window defaults to 30 seconds.
- `ratings` / `rating_ledger`: four independent ratings, initially 1200; transactions create deterministic per-result deltas.
- `reversal_cases` / `reversal_votes`: 24-hour reversal by strict majority of locked original participants; corrected result becomes void.
- `honesty_events`: verified self-admission events; no automatic dishonesty judgment from a minority vote.

## Server-authoritative voting

1. Any round participant marks physical games finished: `begin_results`.
2. First Game 1 nomination starts 30s timer. Same game can receive later votes/changes.
3. A strict majority of all locked round players (`votes > floor(n/2)`) ends voting immediately.
4. At 30s, a unique plurality with >=2 votes finalizes; <2 is unresolved; equal-highest candidates with >=2 each enter tie acceptance.
5. All tied candidates must explicitly accept shared partial loss; otherwise a 30-second runoff restricted to tied candidates opens. Tie acceptances have a 30s timeout, after which a runoff starts.
6. Then Game 2 becomes eligible (where applicable). Game 1 results count even if Game 2 unresolved.
7. Expired timers are evaluated on the server by `advance_expired` called by live clients. **The initial version has no always-on server scheduler for expiring votes.** State converges on the next participant reconnect. For strict prompt timing even with no connected devices, add a scheduled server-side resolver/Edge Function.
8. Manual `restart_unresolved` permitted until the next physical round starts. A round result must be confirmed before Elo is booked.

### Rating formula

For a single losing player L against all n-1 winners i:

```
E_iL = 1 / (1 + 10^((R_L - R_i)/400))
ΔR_i = K/(n-1) * (1-E_iL)  ;  K=32
ΔR_L = -sum(ΔR_i)
```

For a jointly accepted tied loss, each tied loser incurs a reduced, half-weight penalty relative to their pairwise comparisons with remaining winners. All gains/losses remain zero-sum. The number of physical games can be two per parallel round; both are scored against the **same start-of-round rating snapshot**. Ratings are replayed in deterministic order of round start when a result is confirmed or reversed.

This current implementation recalculates all rating history in a mode on every confirmed result or correction. That deliberately favors correctness and reversibility for a small alpha, but **does not scale to a large public platform**. Before launch at scale, implement incremental writes on normal finalization and targeted replay/checkpointing on corrections, and benchmark under contention. PostgreSQL advisory locks serialize rebuilds per mode.

### Trust and security

- Login is handled by Supabase Auth. Only public/project publishable key is embedded in frontend; `service_role` is never shipped.
- Tables have RLS read policies; no authenticated browser role is granted INSERT/UPDATE/DELETE to game and rating tables.
- Public RPC procedures run with `SECURITY DEFINER`, fixed empty `search_path`, and explicit `auth.uid()` checks. These **must be security-reviewed** before public launch.
- Snapshot player authorization rejects outsider ballots, extra participants and votes for a nonparticipant.
- Sensitive individual vote information is unreadable by participants until the ballot finalizes, even though vote totals are accessible.
- The 24-hour window is measured from finalized server timestamp. Revocation recalculates historical mode ratings.
- Concurrent join/start is serialized using locked table rows; voting uses locked game rows; ratings use per-mode advisory transaction locks.
- **Missing for production:** rate limiting, abuse detection, phone-number verification if needed, administrative moderation, privacy-policy and deletion features, and automated database integration tests.

### Scalability path

1. Initial alpha (friends): Supabase Free, Postgres Changes, 4.5-second fallback refresh during active tables.
2. Growing user base: private Realtime Broadcast channels rather than Postgres Changes. Supabase recommends Broadcast for scalability and security; Realtime Postgres Changes remains simpler for small groups. Remove broad fallback polling after verifying Broadcast robustness.
3. High game volume: incremental Elo ledger, background consistency worker, snapshots for historical replay and correction events; add performance and concurrency tests.
4. Uptime requirements: Supabase Pro prevents automatic pausing, or migrate APIs/storage to self-hosted Postgres / Cloudflare D1 + Durable Objects (requires redesign of SQL transactions and Auth).
5. Backup/restore drill: export verified backups (including Auth and relevant schemas), validate replays, and test rolling upgrade migrations.

### Known alpha limitations

- **Not connected to a real account/project in this environment; no live end-to-end test.**
- App requires network access for voting/ratings; installed shell can display while offline but cannot submit game state.
- No server-side scheduled vote expiry if nobody is online.
- No moderation/anti-collusion subsystem. Every validated repeated game counts, as requested; collusion can game global rankings.
- Only correction-by-void, not a full historical replacement-vote process; corrected result may need manual revote where allowed.
- Friend groups show a subset of *global ratings*, not independently computed per-group Elo. Add group-specific rating if needed.
- Stars start at 5.0; verified self-admissions are stored as positive reputation events but do not increase the display above the cap. No penalties are inferred from majority disagreement.
- For profile advanced statistics, the provisional threshold is 10 validated **individual game outcomes**, not 10 physical rounds (parallel games can yield 2). Confirm before freeze.
- Apple provider must be configured; a paid Apple Developer membership may be required. Google provider also needs OAuth setup.
- Hosting keeps costs low but free service limits and Supabase inactivity pausing remain possible.

## Test matrix for next development milestone

1. Register 3 test users; sign in on separate mobile browsers. Verify third-party cannot read tables/ballots not joined.
2. Create Natural table, QR join (3 players), start; fourth login denied joining while playing.
3. Vote 2 of 3 for a loser: early confirmation; 2 winners gain equal rating points from one loser; zero-sum.
4. Concurrent different nominations, edit ballots, expire after 30s, tie offer/refusal/runoff, <2 unresolved and manual restart.
5. Parallel mode: Game 1 confirmed, Game 2 unresolved, game rating stays; same person loses twice in one round.
6. Host transfer and host leave between games; remaining roster retains table.
7. Vote for reversal with majority within 24h; verify entire rating replay and history. Reject after 24h.
8. Same user multiple groups; compare global and private leaderboards; verify username uniqueness.
9. Close phones, return after expiry; verify deadline is evaluated on reconnect without accepting late votes.
10. Run SQL concurrency and adversarial tests before inviting unaffiliated public users.

## Verified official reference material

- Supabase DB functions security: https://supabase.com/docs/guides/database/functions
- Supabase RLS: https://supabase.com/docs/guides/database/postgres/row-level-security
- Supabase Realtime guidance: https://supabase.com/docs/guides/realtime/subscribing-to-database-changes
- Supabase production checklist: https://supabase.com/docs/guides/deployment/going-into-prod
- Supabase Free pausing: https://supabase.com/docs/guides/platform/free-project-pausing
