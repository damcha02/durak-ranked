-- Table controls: 2-hour expiry, stopping a game started by accident, deleting a table,
-- and removing players.
--
-- * Idle tables close after 2 hours (was 24). The job now runs every 10 minutes, so a table
--   closes between 2h and 2h10m after its last activity.
-- * A game that was started but never finished (nobody pressed "Cards finished", or nobody voted)
--   no longer keeps a table open: after 2 hours of inactivity the round is cancelled and the
--   table closes. Only a round with no result yet and not reopened can be cancelled, because
--   cancelling deletes it and a result already rated (or a vote reopened later) must stay.
--   Games without a result (unresolved) still keep a table open, as before.
-- * public.cancel_round(table): the host stops the current round (same rule as above).
-- * public.delete_table(table): the host removes the table. A table that never recorded a
--   game is deleted outright; otherwise it is closed for good (reason 'host') and hidden from
--   every member, so the rating history is kept.
-- * public.kick_member(table, user): the host removes a player from the roster between games.

alter table public.tables add column closed_reason text check (closed_reason in ('inactivity','host'));
update public.tables set closed_reason='inactivity' where closed_at is not null;
alter table public.round_games add column was_reopened boolean not null default false;

-- A game that goes from unresolved back to awaiting was reopened: its round has history.
create or replace function private.mark_reopened() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 new.was_reopened:=true;
 return new;
end $$;
create trigger round_games_mark_reopened before update of state on public.round_games
for each row when (old.state='unresolved' and new.state='awaiting') execute function private.mark_reopened();

-- A round that can be cancelled has no result of any kind and was never reopened.
create or replace function private.round_cancellable(p_round uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select p_round is not null and not exists(select 1 from public.round_games g
  where g.round_id=p_round and (g.was_reopened or g.state in ('confirmed','tied','void','unresolved')));
$$;

-- Deletes the current round of a table (and its games, votes) and returns the table to the lobby.
-- Callers hold the table row lock and the round's game row locks.
create or replace function private.cancel_round_core(p_table uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare rid uuid;
begin
 select current_round_id into rid from public.tables where id=p_table;
 update public.tables set status='lobby',current_round_id=null,updated_at=now() where id=p_table;
 delete from public.rounds where id=rid;
end $$;

-- Closing: the unfinished-game guard no longer applies when the host closes the table.
create or replace function private.tables_lifecycle() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 if old.closed_at is null and new.closed_at is not null and new.closed_reason is distinct from 'host'
    and private.table_has_unfinished_game(new.id) then
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

-- Locks used by every host action: the round's game rows first, then the table row (the order
-- votes use), then re-reads the table.
create or replace function public.cancel_round(p_table uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid:=private.current_user_id(); rid uuid; t public.tables%rowtype;
begin
 select current_round_id into rid from public.tables where id=p_table;
 if rid is not null then perform 1 from public.round_games where round_id=rid order by id for update; end if;
 select * into t from public.tables where id=p_table for update;
 if not found or t.host_id<>uid then raise exception 'Only the host can stop a game'; end if;
 if t.closed_at is not null then raise exception 'Table is closed'; end if;
 if t.current_round_id is null or t.current_round_id is distinct from rid then raise exception 'There is no game to stop'; end if;
 if not private.round_cancellable(rid) then raise exception 'This game already has a result and cannot be stopped'; end if;
 perform private.cancel_round_core(p_table);
end $$;

create or replace function public.delete_table(p_table uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid:=private.current_user_id(); rid uuid; t public.tables%rowtype;
begin
 select current_round_id into rid from public.tables where id=p_table;
 if rid is not null then perform 1 from public.round_games where round_id=rid order by id for update; end if;
 select * into t from public.tables where id=p_table for update;
 if not found or t.host_id<>uid then raise exception 'Only the host can delete the table'; end if;
 if t.closed_at is null then
  if t.current_round_id is distinct from rid then raise exception 'The table changed, try again'; end if;
  if rid is not null then
   if not private.round_cancellable(rid) then raise exception 'Finish the current game before deleting the table'; end if;
   perform private.cancel_round_core(p_table);
  end if;
  if not exists(select 1 from public.rounds where table_id=p_table) then
   delete from public.tables where id=p_table;
   return;
  end if;
  update public.tables set closed_at=now(),closed_reason='host' where id=p_table;
 end if;
 -- Closed tables keep their games (ratings and history); the roster is emptied so nobody sees it.
 update public.table_members set is_active=false where table_id=p_table and is_active;
end $$;

create or replace function public.kick_member(p_table uuid,p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid:=private.current_user_id(); t public.tables%rowtype;
begin
 select * into t from public.tables where id=p_table for update;
 if not found or t.host_id<>uid then raise exception 'Only the host can remove players'; end if;
 if p_user=uid then raise exception 'Use Leave table to leave yourself'; end if;
 if t.closed_at is not null then raise exception 'Table is closed'; end if;
 if t.status<>'lobby' then raise exception 'Remove players between games'; end if;
 if not private.is_table_member(p_table,p_user) then raise exception 'That player is not at this table'; end if;
 update public.table_members set is_active=false where table_id=p_table and user_id=p_user;
end $$;

-- Cleanup. Stage 1: a round with no result at a table idle for p_idle is cancelled and the table
-- closed. Stage 2 (as before): an idle lobby without an unfinished game is closed.
-- Rows another transaction holds are skipped (SKIP LOCKED) and picked up by a later run.
create or replace function private.close_inactive_tables(p_idle interval default interval '2 hours') returns int
language plpgsql security definer set search_path = '' as $$
declare closed int:=0; n int; cand record; total int; got int;
begin
 for cand in
  select t.id,t.current_round_id as rid from public.tables t
  where t.closed_at is null and t.current_round_id is not null and t.last_activity_at<=now()-p_idle
  order by t.id
 loop
  select count(*) into total from public.round_games where round_id=cand.rid;
  select count(*) into got from (select 1 from public.round_games where round_id=cand.rid for update skip locked) x;
  continue when got<>total;
  perform 1 from public.tables t
   where t.id=cand.id and t.closed_at is null and t.current_round_id=cand.rid and t.last_activity_at<=now()-p_idle
   for update skip locked;
  continue when not found;
  continue when not private.round_cancellable(cand.rid);
  perform private.cancel_round_core(cand.id);
  update public.tables set closed_at=now(),closed_reason='inactivity' where id=cand.id;
  closed:=closed+1;
 end loop;

 with due as (
  select t.id from public.tables t
  where t.closed_at is null and t.status='lobby' and t.current_round_id is null and t.last_activity_at<=now()-p_idle
   and not private.table_has_unfinished_game(t.id)
  order by t.id
  for update skip locked
 )
 update public.tables t set closed_at=now(),closed_reason='inactivity'
 from due
 where t.id=due.id and t.closed_at is null and t.status='lobby' and t.current_round_id is null
  and t.last_activity_at<=now()-p_idle
  and not private.table_has_unfinished_game(t.id);
 get diagnostics n=row_count;
 return closed+n;
end $$;

revoke execute on function private.mark_reopened() from public,anon,authenticated;
revoke execute on function private.round_cancellable(uuid) from public,anon,authenticated;
revoke execute on function private.cancel_round_core(uuid) from public,anon,authenticated;
revoke execute on function private.close_inactive_tables(interval) from public,anon,authenticated;
revoke execute on function public.cancel_round(uuid) from public,anon;
revoke execute on function public.delete_table(uuid) from public,anon;
revoke execute on function public.kick_member(uuid,uuid) from public,anon;
grant execute on function public.cancel_round(uuid) to authenticated;
grant execute on function public.delete_table(uuid) to authenticated;
grant execute on function public.kick_member(uuid,uuid) to authenticated;

-- Every 10 minutes instead of hourly. Same job name, so this replaces the old schedule.
do $$
begin
 create extension if not exists pg_cron with schema pg_catalog;
 perform cron.schedule('durak-close-inactive-tables','*/10 * * * *','select private.close_inactive_tables()');
exception when others then
 raise warning 'Table expiry NOT scheduled (%). Schedule "select private.close_inactive_tables()" every 10 minutes; see docs/TABLE_EXPIRY.md', sqlerrm;
end $$;
