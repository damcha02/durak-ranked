# Automatic table expiry

A lobby that has had no meaningful activity for 24 hours is closed by the server. Migration:
`supabase/migrations/202610280002_table_expiry.sql`.

## Rules

- **Activity** (moves `tables.last_activity_at` to the time of the action): a player joins or
  leaves, the host changes, a round starts, cards are finished (results begin), a game changes
  state (voting opens, tie offer, runoff, reopened vote, a result, a correction), a vote or a
  tie response is cast. Triggers record it inside the transaction of the RPC that made the
  change. Reading a table, refreshing, or keeping the app open changes nothing, so it does not
  count.
- **Finished games**: `private.table_has_unfinished_game(table)` is the rule. A game is finished
  only when its result is final: `confirmed` (a loser), `tied` (a shared loss) or `void`
  (reversed by a correction vote). Every other game is unfinished: `awaiting`, `voting`,
  `tie_offer`, and `unresolved` (the vote ended without a loser). An unresolved game can be
  reopened at any later time with `restart_unresolved`, also after later rounds, so it counts as
  unfinished for expiry even though the round has ended and the table is back in the lobby.
- **Closing**: `private.close_inactive_tables()` closes a table only when it is an idle lobby
  (`status = 'lobby'`, no current round), none of its games in any round is unfinished, and its
  last activity is at least 24 hours old. A table with an unfinished game never closes, however
  long it waits: in the middle of a round, with an unresolved vote, or with Game 2 of a parallel
  round unresolved. Its players can reopen and decide the vote after days. When the last
  unfinished game gets its result, that result is activity, so the table gets a fresh 24 hours
  from then. The `tables_lifecycle` trigger refuses to set `closed_at` on a table with an
  unfinished game, whoever tries.
- **A closed table** (`closed_at` set) is final. It rejects joins (including re-joins) and
  new rounds, and it has no game left to reopen. Its members can still open it and see why it closed, and
  they can leave it. Nothing is deleted: members, rounds, games, votes, ratings, the
  ledger and corrections stay as they were. History and corrections within 24 hours of a
  result keep working.
- The job runs hourly, so a lobby closes between 24 and 25 hours after its last activity.

Existing tables, when the migration is applied, start from their latest recorded activity
(creation, last update, last join, round start, result, vote or tie response). Lobbies that were
already idle for 24 hours, and have no unfinished game, close at the first scheduled run after
the migration. To see beforehand which existing tables an unresolved game keeps open:

```sql
select distinct r.table_id from public.round_games g join public.rounds r on r.id = g.round_id
where g.state = 'unresolved';
```

## Scheduling (Supabase Cron / pg_cron)

The migration installs `pg_cron` and schedules the job `durak-close-inactive-tables` for
minute 7 of every hour (`7 * * * *`). It runs `select private.close_inactive_tables()`.

If `pg_cron` cannot be installed (for example, Cron is not enabled for the project), the migration
still applies and prints:

```
WARNING:  Table expiry NOT scheduled (...)
```

In that case, enable **Integrations → Cron** in the Supabase dashboard and create the job there,
or run in the SQL editor:

```sql
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('durak-close-inactive-tables', '7 * * * *', 'select private.close_inactive_tables()');
```

Check it:

```sql
select jobname, schedule, command, active from cron.job;
select status, return_message, start_time from cron.job_run_details order by start_time desc limit 5;
select count(*) filter (where closed_at is not null) as closed, count(*) filter (where closed_at is null) as open from public.tables;
```

`return_message` is `1 row` and the run closed what it reported (`select private.close_inactive_tables()` returns the
number of tables it closed). To pause expiry: `select cron.unschedule('durak-close-inactive-tables');`.

## Concurrency

Every RPC that can make a table busy or active locks or updates that table's row. Cleanup takes
the row locks with `SKIP LOCKED` and re-checks every condition under the lock, so:

- a join, round start, vote, reopened vote or result already in progress keeps the table open
  (cleanup skips it that hour, and the action's activity then resets the timer);
- a game never moves from finished back to unfinished, and a new game only appears after the
  table has left the lobby, so a stale view of the games cannot make cleanup close a table that
  just got an unfinished game; the table columns are re-checked on the latest row version;
- reopening a vote locks the game row, then the table row (`restart_unresolved`); cleanup never
  takes a lock on a table with an unfinished game, so reopening never waits for it;
- an action that arrives while a table is being closed waits for the closing transaction and is
  then refused with "Table closed due to inactivity";
- concurrent or repeated cleanups close a table once.

Lock order is game row, then table row, then the per-mode rating lock, the same as before. Cleanup
only takes table rows, so it cannot deadlock with game actions.

`tests/tableExpiry.concurrency.test.ts` checks this against a real PostgreSQL server with
several sessions (PGlite, used by the other tests, has one connection):

```
docker run -d --name durak-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
DURAK_TEST_PG_URL=postgresql://postgres:pw@127.0.0.1:55432/postgres npx vitest run tests/tableExpiry.concurrency.test.ts
```

It creates and drops its own database. It is skipped when `DURAK_TEST_PG_URL` is not set.
