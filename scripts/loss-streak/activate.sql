-- Losing-streak penalty activation: back up, switch the rule on from now, replay every mode, in ONE transaction.
-- Prerequisites: Elo V2 is active, and migration 202610290001_loss_streak_penalty.sql is applied
-- (it is inert while streak_rule='off').
--
-- Rehearsal (default): does everything, prints the result, then ROLLS BACK. Nothing persists.
--   psql "<connection>" -X -v ON_ERROR_STOP=1 -f scripts/loss-streak/activate.sql
-- Activation: same, but COMMITS when every check passes.
--   psql "<connection>" -X -v ON_ERROR_STOP=1 -v commit=on -f scripts/loss-streak/activate.sql
--
-- The rule only covers rounds started at or after the activation time, so activation itself must
-- leave every rating and ledger delta exactly as it was, and every streak at 0. It checks that,
-- and that game history, accounts and memberships are unchanged, before it commits.
\set ON_ERROR_STOP on
\if :{?commit}
\else
\set commit off
\endif

begin;
set local lock_timeout = '10s';
set local statement_timeout = '5min';
set local client_min_messages = warning;

-- 0. Preconditions.
do $$
begin
 if to_regprocedure('private.elo_streak_game_deltas(uuid[],numeric[],uuid[],numeric,text,uuid[])') is null then
  raise exception 'Migration 202610290001_loss_streak_penalty.sql is not applied';
 end if;
 if (select formula from private.rating_config) <> 'v2' then
  raise exception 'Elo V2 is not active (formula=%); the streak penalty extends V2', (select formula from private.rating_config);
 end if;
 if (select streak_rule from private.rating_config) <> 'off' then
  raise exception 'The losing-streak penalty is already active (rule %, from %)',
   (select streak_rule from private.rating_config), (select streak_from from private.rating_config);
 end if;
 if to_regnamespace('loss_streak_backup') is not null then
  raise exception 'Schema loss_streak_backup already exists; inspect or rename it before activating again';
 end if;
end $$;

-- 1. Locks: the same tables, modes and order as the Elo V2 scripts.
lock table public.profiles, public.friend_groups, public.group_members, public.tables, public.table_members,
 public.rounds, public.round_players, public.round_games, public.game_votes, public.vote_totals,
 public.tie_responses, public.honesty_events, public.reversal_cases, public.reversal_votes in share mode;
lock table public.ratings, public.rating_ledger in exclusive mode;
select pg_advisory_xact_lock(hashtextextended('durak-rating-'||m::text,0))
from unnest(enum_range(null::public.durak_mode)) as t(m);

create temporary table streak_checksums(phase text, tbl text, row_count bigint, digest text) on commit drop;
create or replace function pg_temp.streak_checksum(p_phase text) returns void language plpgsql as $$
declare t text;
begin
 foreach t in array array['profiles','friend_groups','group_members','tables','table_members','rounds','round_players',
  'round_games','game_votes','vote_totals','tie_responses','honesty_events','reversal_cases','reversal_votes'] loop
  execute format($q$insert into pg_temp.streak_checksums
   select %L,%L,count(*),md5(coalesce(string_agg(md5(x::text),'' order by md5(x::text)),'')) from public.%I x$q$,p_phase,t,t);
 end loop;
end $$;
select pg_temp.streak_checksum('before');

-- 2. Backup (not exposed through the API; no grants to browser roles).
create schema loss_streak_backup;
revoke all on schema loss_streak_backup from public;
create table loss_streak_backup.ratings as select * from public.ratings;
create table loss_streak_backup.rating_ledger as select * from public.rating_ledger;
create table loss_streak_backup.rating_config as select * from private.rating_config;
create table loss_streak_backup.checksums as select tbl,row_count,digest from pg_temp.streak_checksums;
create table loss_streak_backup.meta as select now() as taken_at, current_user as taken_by,
 (select md5(coalesce(string_agg(md5(x::text),'' order by md5(x::text)),'')) from (
   select g.id,g.round_id,g.slot,g.state,g.loser_ids,g.finalized_at,r.started_at,t.mode,
    (select array_agg(rp.user_id order by rp.user_id) from public.round_players rp where rp.round_id=r.id) as roster
   from public.round_games g join public.rounds r on r.id=g.round_id join public.tables t on t.id=r.table_id) x) as history_digest;
do $$
declare t text;
begin
 foreach t in array array['ratings','rating_ledger','rating_config','checksums','meta'] loop
  execute format('revoke all on loss_streak_backup.%I from public', t);
  if exists(select 1 from pg_roles where rolname='anon') then execute format('revoke all on loss_streak_backup.%I from anon, authenticated', t); end if;
 end loop;
end $$;

-- 3. Switch: the rule covers rounds started from this transaction's start time on. Replay every mode.
update private.rating_config set streak_rule='loss_streak_v1', streak_from=now(), updated_at=now();
select private.rebuild_mode(m) from unnest(enum_range(null::public.durak_mode)) as t(m);

-- 4. Verify. Any failure raises and aborts the transaction.
select pg_temp.streak_checksum('after');
do $$
declare bad text; k numeric; m public.durak_mode;
begin
 select string_agg(b.tbl,', ') into bad from pg_temp.streak_checksums b
  join pg_temp.streak_checksums a on a.tbl=b.tbl and a.phase='after'
  where b.phase='before' and (a.row_count,a.digest) is distinct from (b.row_count,b.digest);
 if bad is not null then raise exception 'Game/account tables changed: %', bad; end if;

 if (select streak_rule from private.rating_config)<>'loss_streak_v1' or (select streak_from from private.rating_config) is null then
  raise exception 'Switch not set';
 end if;
 if exists(select 1 from public.rounds r where r.started_at>=(select streak_from from private.rating_config)) then
  raise exception 'A round already starts at or after the activation time';
 end if;
 -- No old game is re-rated: ratings and every ledger delta are exactly what they were.
 if exists(select user_id,mode,rating,games,losses from public.ratings except select user_id,mode,rating,games,losses from loss_streak_backup.ratings)
    or exists(select user_id,mode,rating,games,losses from loss_streak_backup.ratings except select user_id,mode,rating,games,losses from public.ratings) then
  raise exception 'Ratings changed at activation';
 end if;
 if exists(select game_id,user_id,mode,delta,recorded_at from public.rating_ledger except select game_id,user_id,mode,delta,recorded_at from loss_streak_backup.rating_ledger)
    or exists(select game_id,user_id,mode,delta,recorded_at from loss_streak_backup.rating_ledger except select game_id,user_id,mode,delta,recorded_at from public.rating_ledger) then
  raise exception 'Ledger changed at activation';
 end if;
 -- Every count starts at zero.
 if exists(select 1 from public.ratings where loss_streak<>0)
    or exists(select 1 from public.rating_ledger where streak_extra<>0 or loss_streak is not null) then
  raise exception 'A streak or penalty exists at activation';
 end if;
 -- An independent second replay reproduces the stored state.
 select c.k into k from private.rating_config c;
 foreach m in array enum_range(null::public.durak_mode) loop
  perform private.elo_v2_replay(m,k);
  if exists(select 1 from pg_temp.elo_v2_ratings s join public.ratings r on r.user_id=s.user_id and r.mode=m
            where r.rating::numeric<>s.rating or r.games<>s.games or r.losses<>s.losses or r.loss_streak<>s.loss_streak) then
   raise exception 'Replay is not reproducible in mode %', m;
  end if;
 end loop;
end $$;
select 'All losing-streak activation checks passed' as result;
select streak_rule, streak_from, formula, k from private.rating_config;

\if :commit
commit;
\echo 'Losing-streak penalty ACTIVATED and committed. Backup kept in schema loss_streak_backup.'
\else
rollback;
\echo 'Rehearsal only: everything above was ROLLED BACK. Re-run with -v commit=on to activate.'
\endif
