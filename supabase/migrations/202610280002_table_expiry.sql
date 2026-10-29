-- Automatic table expiry: a lobby closes after 24 hours without meaningful activity.
--
-- * tables.last_activity_at is maintained by triggers that run inside the transaction of
--   whichever RPC changed the table: a member joins or leaves, the host changes, a round
--   starts or moves between playing/results/lobby, a game changes state (voting opens, tie
--   offer, runoff, reopened vote, result, correction), a vote or tie response is cast.
--   Triggers fire only on real row changes, so reading a table never moves the timer, and
--   no existing RPC body is modified.
-- * tables.closed_at is set by private.close_inactive_tables(), scheduled hourly with pg_cron.
--   A table closes only as an idle lobby (status 'lobby', no current round) none of whose
--   games is unfinished (private.table_has_unfinished_game). An unresolved game (the vote
--   ended without a loser) counts as unfinished: it can be reopened at any later time, so it
--   keeps its table open indefinitely, in any round and in either game of a parallel round.
--   A result moves last_activity_at to the resolution time, so the last game resolved after
--   a long pause starts a fresh 24 hours.
-- * Closing is final and only sets closed_at: members, rounds, games, votes, ratings, the
--   ledger and corrections are untouched. A closed table rejects joins, new rounds and
--   reopened votes; its members can still read it and leave it.

alter table public.tables
 add column last_activity_at timestamptz not null default now(),
 add column closed_at timestamptz;

-- Existing tables: the latest recorded activity of each table (never later than now).
-- Lobbies already idle for 24 hours close at the first scheduled run after this migration.
update public.tables t set last_activity_at=least(now(),greatest(t.created_at,t.updated_at,
 (select max(m.joined_at) from public.table_members m where m.table_id=t.id),
 (select max(r.started_at) from public.rounds r where r.table_id=t.id),
 (select max(g.finalized_at) from public.round_games g join public.rounds r on r.id=g.round_id where r.table_id=t.id),
 (select max(v.updated_at) from public.game_votes v join public.round_games g on g.id=v.game_id join public.rounds r on r.id=g.round_id where r.table_id=t.id),
 (select max(tr.responded_at) from public.tie_responses tr join public.round_games g on g.id=tr.game_id join public.rounds r on r.id=g.round_id where r.table_id=t.id)));

alter table public.tables add constraint tables_closed_only_when_idle
 check (closed_at is null or (status='lobby' and current_round_id is null));
create index tables_open_by_activity on public.tables(last_activity_at) where closed_at is null;

-- The rule expiry relies on. A game is finished only when its result is final: a loser
-- (confirmed), a shared loss (tied), or a reversal after a correction vote (void). Every other
-- game is unfinished: still being played or voted on (awaiting, voting, tie_offer), or without
-- a result (unresolved), which a player of its round can reopen at any later time with
-- public.restart_unresolved. Unresolved games of earlier rounds count too. A finished game
-- never becomes unfinished again, and a new game only appears once the table has left the
-- lobby, so this cannot turn true behind a locked table row.
create or replace function private.table_has_unfinished_game(p_table uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.rounds r join public.round_games g on g.round_id=r.id
  where r.table_id=p_table and g.state not in ('confirmed','tied','void'));
$$;
create index round_games_unfinished on public.round_games(round_id) where state not in ('confirmed','tied','void');

create or replace function private.touch_table(p_table uuid) returns void
language sql security definer set search_path = '' as $$
 update public.tables set last_activity_at=now()
 where id=p_table and closed_at is null and last_activity_at<now();
$$;
create or replace function private.table_of_game(p_game uuid) returns uuid
language sql stable security definer set search_path = '' as $$
 select r.table_id from public.round_games g join public.rounds r on r.id=g.round_id where g.id=p_game;
$$;
create or replace function private.reject_if_closed(p_table uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
 if exists(select 1 from public.tables t where t.id=p_table and t.closed_at is not null) then
  raise exception 'Table closed due to inactivity. Start a new table to play again.';
 end if;
end $$;

-- tables: host, status and round changes are activity; a closed table cannot be reopened, and
-- a table with an unfinished game cannot be closed (whoever tries).
create or replace function private.tables_lifecycle() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 if old.closed_at is null and new.closed_at is not null and private.table_has_unfinished_game(new.id) then
  raise exception 'A table with an unfinished game cannot be closed';
 end if;
 if old.closed_at is not null then
  if new.closed_at is distinct from old.closed_at or new.status is distinct from old.status
     or new.current_round_id is distinct from old.current_round_id then
   raise exception 'Table closed due to inactivity. Start a new table to play again.';
  end if;
 elsif new.closed_at is null and (new.host_id is distinct from old.host_id or new.status is distinct from old.status
     or new.current_round_id is distinct from old.current_round_id) then
  new.last_activity_at:=now();
 end if;
 return new;
end $$;
create trigger tables_lifecycle before update on public.tables
for each row execute function private.tables_lifecycle();

-- Joining (or re-joining) a closed table is refused; leaving one is allowed.
create or replace function private.table_members_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 if new.is_active then perform private.reject_if_closed(new.table_id); end if;
 return new;
end $$;
create trigger table_members_guard before insert or update on public.table_members
for each row execute function private.table_members_guard();
create or replace function private.table_members_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 if tg_op='INSERT' or old.is_active is distinct from new.is_active or old.joined_at is distinct from new.joined_at then
  perform private.touch_table(new.table_id);
 end if;
 return null;
end $$;
create trigger table_members_activity after insert or update on public.table_members
for each row execute function private.table_members_activity();

create or replace function private.rounds_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 perform private.reject_if_closed(new.table_id);
 return new;
end $$;
create trigger rounds_guard before insert on public.rounds
for each row execute function private.rounds_guard();
create or replace function private.rounds_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 perform private.touch_table(new.table_id);
 return null;
end $$;
create trigger rounds_activity after insert on public.rounds
for each row execute function private.rounds_activity();

create or replace function private.game_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 perform private.touch_table(private.table_of_game(new.game_id));
 return null;
end $$;
create trigger game_votes_activity after insert or update on public.game_votes
for each row execute function private.game_activity();
create trigger tie_responses_activity after insert or update on public.tie_responses
for each row execute function private.game_activity();
create or replace function private.round_games_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 perform private.touch_table(private.table_of_game(new.id));
 return null;
end $$;
create trigger round_games_activity after update of state on public.round_games
for each row when (old.state is distinct from new.state) execute function private.round_games_activity();

-- Closes every idle lobby without an unfinished game whose last activity is at least p_idle
-- ago; returns how many. Idempotent. Rows another transaction is changing right now are
-- skipped (SKIP LOCKED) and picked up by a later run; every RPC that can make a table busy or
-- active (including reopening a vote) locks or updates the table row, so the conditions
-- re-checked under the row lock are authoritative.
create or replace function private.close_inactive_tables(p_idle interval default interval '24 hours') returns int
language plpgsql security definer set search_path = '' as $$
declare closed int;
begin
 with due as (
  select t.id from public.tables t
  where t.closed_at is null and t.status='lobby' and t.current_round_id is null and t.last_activity_at<=now()-p_idle
   and not private.table_has_unfinished_game(t.id)
  order by t.id
  for update skip locked
 )
 update public.tables t set closed_at=now()
 from due
 where t.id=due.id and t.closed_at is null and t.status='lobby' and t.current_round_id is null
  and t.last_activity_at<=now()-p_idle
  and not private.table_has_unfinished_game(t.id);
 get diagnostics closed=row_count;
 return closed;
end $$;

revoke execute on function private.table_has_unfinished_game(uuid) from public,anon,authenticated;
revoke execute on function private.touch_table(uuid) from public,anon,authenticated;
revoke execute on function private.table_of_game(uuid) from public,anon,authenticated;
revoke execute on function private.reject_if_closed(uuid) from public,anon,authenticated;
revoke execute on function private.tables_lifecycle() from public,anon,authenticated;
revoke execute on function private.table_members_guard() from public,anon,authenticated;
revoke execute on function private.table_members_activity() from public,anon,authenticated;
revoke execute on function private.rounds_guard() from public,anon,authenticated;
revoke execute on function private.rounds_activity() from public,anon,authenticated;
revoke execute on function private.game_activity() from public,anon,authenticated;
revoke execute on function private.round_games_activity() from public,anon,authenticated;
revoke execute on function private.close_inactive_tables(interval) from public,anon,authenticated;

-- Hourly schedule (Supabase Cron = pg_cron). Re-running this replaces the job of the same name.
-- pg_cron can only be installed in the database named by cron.database_name ('postgres' on
-- Supabase). If it cannot be installed here (local test databases, or a project where Cron is
-- not enabled), the migration still applies and prints a WARNING: schedule the job by hand as
-- described in docs/TABLE_EXPIRY.md, and check it with: select * from cron.job;
do $$
begin
 create extension if not exists pg_cron with schema pg_catalog;
 perform cron.schedule('durak-close-inactive-tables','7 * * * *','select private.close_inactive_tables()');
exception when others then
 raise warning 'Table expiry NOT scheduled (%). Schedule "select private.close_inactive_tables()" hourly; see docs/TABLE_EXPIRY.md', sqlerrm;
end $$;
