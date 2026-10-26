-- Elo V2 activation: back up, switch to V2 and replay every mode, all in ONE transaction.
-- Prerequisite: migration 202610260001_elo_v2.sql is applied (it is inert while formula='v1').
--
-- Rehearsal (default): does everything, prints the result, then ROLLS BACK. Nothing persists.
--   psql "<connection>" -X -v ON_ERROR_STOP=1 -f scripts/elo-v2/activate.sql
-- Activation: same, but COMMITS when every check passes.
--   psql "<connection>" -X -v ON_ERROR_STOP=1 -v commit=on -f scripts/elo-v2/activate.sql
--
-- Any failed check raises an exception; with ON_ERROR_STOP psql stops before COMMIT and the
-- server rolls the whole transaction back (ratings, ledger, switch and backup alike).
-- Game history (rounds, rosters, games, votes, ties, corrections), accounts and memberships
-- are never written; their checksums are verified unchanged before commit.
\set ON_ERROR_STOP on
\if :{?commit}
\else
\set commit off
\endif

begin;
-- Do not stall the app: give up (and roll back) if the locks are not free within 10 s.
set local lock_timeout = '10s';
set local statement_timeout = '5min';
-- Hide the replay's harmless "temp table already exists, skipping" notices; results are printed below.
set local client_min_messages = warning;

-- 0. Preconditions.
do $$
begin
 if to_regprocedure('private.rebuild_mode_v2(public.durak_mode)') is null
    or to_regprocedure('private.rebuild_mode_v1(public.durak_mode)') is null
    or to_regclass('private.rating_config') is null then
  raise exception 'Migration 202610260001_elo_v2.sql is not applied';
 end if;
 if (select formula from private.rating_config) <> 'v1' then
  raise exception 'Elo V2 is already active (formula=%)', (select formula from private.rating_config);
 end if;
 if to_regnamespace('elo_v2_backup') is not null then
  raise exception 'Schema elo_v2_backup already exists; inspect or rename it before activating again';
 end if;
end $$;

-- 1. Locks. SHARE blocks every write to game history and accounts (and waits for in-flight
-- game transactions to finish) while still allowing reads. Ratings/ledger: EXCLUSIVE (reads ok).
-- Table locks come first, the per-mode rating locks second: the same order a finishing game
-- ends up in, so the two cannot deadlock.
lock table public.profiles, public.friend_groups, public.group_members, public.tables, public.table_members,
 public.rounds, public.round_players, public.round_games, public.game_votes, public.vote_totals,
 public.tie_responses, public.honesty_events, public.reversal_cases, public.reversal_votes in share mode;
lock table public.ratings, public.rating_ledger in exclusive mode;
select pg_advisory_xact_lock(hashtextextended('durak-rating-'||m::text,0))
from unnest(enum_range(null::public.durak_mode)) as t(m);

-- Checksums of everything that must not change.
create temporary table elo_v2_checksums(phase text, tbl text, row_count bigint, digest text) on commit drop;
create or replace function pg_temp.elo_v2_checksum(p_phase text) returns void language plpgsql as $$
declare t text;
begin
 foreach t in array array['profiles','friend_groups','group_members','tables','table_members','rounds','round_players',
  'round_games','game_votes','vote_totals','tie_responses','honesty_events','reversal_cases','reversal_votes'] loop
  execute format($q$insert into pg_temp.elo_v2_checksums
   select %L,%L,count(*),md5(coalesce(string_agg(md5(x::text),'' order by md5(x::text)),'')) from public.%I x$q$,p_phase,t,t);
 end loop;
end $$;
select pg_temp.elo_v2_checksum('before');

-- 2. Backup (outside the API-exposed public schema; no grants to browser roles).
create schema elo_v2_backup;
revoke all on schema elo_v2_backup from public;
create table elo_v2_backup.ratings as select * from public.ratings;
create table elo_v2_backup.rating_ledger as select * from public.rating_ledger;
create table elo_v2_backup.rating_config as select * from private.rating_config;
-- Copies of the replay inputs, for reference (the originals are never modified).
create table elo_v2_backup.rounds as select * from public.rounds;
create table elo_v2_backup.round_players as select * from public.round_players;
create table elo_v2_backup.round_games as select * from public.round_games;
create table elo_v2_backup.reversal_cases as select * from public.reversal_cases;
create table elo_v2_backup.checksums as select tbl,row_count,digest from pg_temp.elo_v2_checksums;
create table elo_v2_backup.meta as select now() as taken_at, current_user as taken_by,
 (select formula from private.rating_config) as formula_before,
 (select md5(coalesce(string_agg(md5(x::text),'' order by md5(x::text)),'')) from (
   select g.id,g.round_id,g.slot,g.state,g.loser_ids,g.finalized_at,r.started_at,t.mode,
    (select array_agg(rp.user_id order by rp.user_id) from public.round_players rp where rp.round_id=r.id) as roster
   from public.round_games g join public.rounds r on r.id=g.round_id join public.tables t on t.id=r.table_id) x) as history_digest;
do $$
declare t text;
begin
 foreach t in array array['ratings','rating_ledger','rating_config','rounds','round_players','round_games','reversal_cases','checksums','meta'] loop
  execute format('revoke all on elo_v2_backup.%I from public', t);
  if exists(select 1 from pg_roles where rolname='anon') then execute format('revoke all on elo_v2_backup.%I from anon, authenticated', t); end if;
 end loop;
end $$;

-- 3. Switch and replay every mode under V2.
update private.rating_config set formula='v2', updated_at=now();
select private.rebuild_mode(m) from unnest(enum_range(null::public.durak_mode)) as t(m);

-- 4. Verify. Any failure raises and aborts the transaction.
select pg_temp.elo_v2_checksum('after');
do $$
declare bad text; k numeric; m public.durak_mode;
begin
 select string_agg(b.tbl,', ') into bad from pg_temp.elo_v2_checksums b
  join pg_temp.elo_v2_checksums a on a.tbl=b.tbl and a.phase='after'
  where b.phase='before' and (a.row_count,a.digest) is distinct from (b.row_count,b.digest);
 if bad is not null then raise exception 'Game/account tables changed: %', bad; end if;

 if (select formula from private.rating_config)<>'v2' then raise exception 'Switch not set'; end if;

 if exists(select game_id,user_id,mode,recorded_at from public.rating_ledger
           except select game_id,user_id,mode,recorded_at from elo_v2_backup.rating_ledger)
    or exists(select game_id,user_id,mode,recorded_at from elo_v2_backup.rating_ledger
           except select game_id,user_id,mode,recorded_at from public.rating_ledger) then
  raise exception 'Ledger keys differ from the backup';
 end if;
 if exists(select 1 from public.rating_ledger group by game_id having sum(delta::numeric)<>0) then
  raise exception 'A game does not sum to exactly zero';
 end if;
 if exists(select 1 from public.rating_ledger where delta::numeric<>round(delta::numeric,2)) then
  raise exception 'A delta is not a whole number of cents';
 end if;
 if exists(select mode from public.ratings group by mode having sum(rating::numeric)<>1200*count(*)) then
  raise exception 'Ratings in a mode do not sum to 1200 per player';
 end if;
 if exists(select user_id,mode,games,losses from public.ratings except select user_id,mode,games,losses from elo_v2_backup.ratings)
    or exists(select user_id,mode,games,losses from elo_v2_backup.ratings except select user_id,mode,games,losses from public.ratings) then
  raise exception 'Games/losses counts or rating rows changed';
 end if;

 -- Idempotence: an independent second replay must reproduce the stored ratings exactly.
 select c.k into k from private.rating_config c;
 foreach m in array enum_range(null::public.durak_mode) loop
  perform private.elo_v2_replay(m,k);
  if exists(select 1 from pg_temp.elo_v2_ratings s join public.ratings r on r.user_id=s.user_id and r.mode=m
            where r.rating::numeric<>s.rating or r.games<>s.games or r.losses<>s.losses) then
   raise exception 'Replay is not reproducible in mode %', m;
  end if;
 end loop;
end $$;
select 'All Elo V2 activation checks passed' as result;

-- 5. What changed (players with at least one rated game).
select r.mode, p.username, round(b.rating::numeric,2) as v1_rating, round(r.rating::numeric,2) as v2_rating,
 round(r.rating::numeric-b.rating::numeric,2) as change, r.games, r.losses,
 rank() over (partition by r.mode order by b.rating desc) as v1_rank,
 rank() over (partition by r.mode order by r.rating desc) as v2_rank
from public.ratings r
join elo_v2_backup.ratings b on b.user_id=r.user_id and b.mode=r.mode
join public.profiles p on p.id=r.user_id
where r.games>0
order by r.mode, r.rating desc, p.username;

\if :commit
commit;
\echo 'Elo V2 ACTIVATED and committed. Backup kept in schema elo_v2_backup.'
\else
rollback;
\echo 'Rehearsal only: everything above was ROLLED BACK. Re-run with -v commit=on to activate.'
\endif
