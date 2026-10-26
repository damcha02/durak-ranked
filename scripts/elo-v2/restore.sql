-- Elo V2 restore: switch back to V1 and replay every mode, in ONE transaction.
-- Ratings are restored by replaying the full history under V1 (not by copying old rows),
-- so games played after activation are kept and rated consistently. If the history is
-- unchanged since activation, the result must equal the elo_v2_backup snapshot exactly.
--
-- Rehearsal (default): does everything, prints the result, then ROLLS BACK.
--   psql "<connection>" -X -v ON_ERROR_STOP=1 -f scripts/elo-v2/restore.sql
-- Restore: same, but COMMITS when every check passes.
--   psql "<connection>" -X -v ON_ERROR_STOP=1 -v commit=on -f scripts/elo-v2/restore.sql
-- The backup schema is left in place; drop it manually once it is no longer needed.
\set ON_ERROR_STOP on
\if :{?commit}
\else
\set commit off
\endif

begin;
set local lock_timeout = '10s';
set local statement_timeout = '5min';
-- Hide the replay's harmless "temp table already exists, skipping" notices; results are printed below.
set local client_min_messages = warning;

do $$
begin
 if to_regclass('elo_v2_backup.ratings') is null or to_regclass('elo_v2_backup.meta') is null then
  raise exception 'No elo_v2_backup snapshot found';
 end if;
 if to_regprocedure('private.rebuild_mode_v1(public.durak_mode)') is null then
  raise exception 'Migration 202610260001_elo_v2.sql is not applied';
 end if;
 if (select formula from private.rating_config) <> 'v2' then
  raise exception 'Elo V2 is not active (formula=%); nothing to restore', (select formula from private.rating_config);
 end if;
end $$;

-- Same locks, same order as activation.
lock table public.profiles, public.friend_groups, public.group_members, public.tables, public.table_members,
 public.rounds, public.round_players, public.round_games, public.game_votes, public.vote_totals,
 public.tie_responses, public.honesty_events, public.reversal_cases, public.reversal_votes in share mode;
lock table public.ratings, public.rating_ledger in exclusive mode;
select pg_advisory_xact_lock(hashtextextended('durak-rating-'||m::text,0))
from unnest(enum_range(null::public.durak_mode)) as t(m);

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
-- Ratings as they are under V2, for the summary below.
create temporary table elo_v2_restore_from on commit drop as select * from public.ratings;
create temporary table elo_v2_restore_result(result text) on commit drop;

update private.rating_config set formula='v1', updated_at=now();
select private.rebuild_mode(m) from unnest(enum_range(null::public.durak_mode)) as t(m);

select pg_temp.elo_v2_checksum('after');
do $$
declare bad text; same_history boolean; max_rating double precision; max_delta double precision;
begin
 select string_agg(b.tbl,', ') into bad from pg_temp.elo_v2_checksums b
  join pg_temp.elo_v2_checksums a on a.tbl=b.tbl and a.phase='after'
  where b.phase='before' and (a.row_count,a.digest) is distinct from (b.row_count,b.digest);
 if bad is not null then raise exception 'Game/account tables changed: %', bad; end if;

 -- Ledger shape: exactly one row per participant per rated game, each game zero-sum.
 if exists(select g.id,rp.user_id from public.round_games g join public.round_players rp on rp.round_id=g.round_id
           where g.state in ('confirmed','tied') except select game_id,user_id from public.rating_ledger)
    or exists(select game_id,user_id from public.rating_ledger except
           select g.id,rp.user_id from public.round_games g join public.round_players rp on rp.round_id=g.round_id
           where g.state in ('confirmed','tied')) then
  raise exception 'Ledger does not have exactly one row per participant per rated game';
 end if;
 if exists(select 1 from public.rating_ledger group by game_id having abs(sum(delta))>1e-6) then
  raise exception 'A game does not sum to zero';
 end if;

 select (select md5(coalesce(string_agg(md5(x::text),'' order by md5(x::text)),'')) from (
   select g.id,g.round_id,g.slot,g.state,g.loser_ids,g.finalized_at,r.started_at,t.mode,
    (select array_agg(rp.user_id order by rp.user_id) from public.round_players rp where rp.round_id=r.id) as roster
   from public.round_games g join public.rounds r on r.id=g.round_id join public.tables t on t.id=r.table_id) x)
  = (select history_digest from elo_v2_backup.meta) into same_history;

 if same_history then
  -- Nothing was played or corrected since activation: must equal the pre-activation snapshot.
  if exists(select user_id,mode,games,losses from public.ratings except select user_id,mode,games,losses from elo_v2_backup.ratings)
     or exists(select user_id,mode,games,losses from elo_v2_backup.ratings except select user_id,mode,games,losses from public.ratings) then
   raise exception 'Games/losses differ from the backup';
  end if;
  select max(abs(r.rating-b.rating)) into max_rating from public.ratings r join elo_v2_backup.ratings b using(user_id,mode);
  select max(abs(l.delta-b.delta)) into max_delta from public.rating_ledger l join elo_v2_backup.rating_ledger b using(game_id,user_id);
  if coalesce(max_rating,0)>1e-6 or coalesce(max_delta,0)>1e-6
     or (select count(*) from public.rating_ledger)<>(select count(*) from elo_v2_backup.rating_ledger) then
   raise exception 'V1 replay differs from the backup (max rating diff %, max delta diff %)', max_rating, max_delta;
  end if;
  insert into pg_temp.elo_v2_restore_result values(format('History unchanged since activation: V1 ratings equal the backup (max diff %s)',coalesce(max_rating,0)));
 else
  insert into pg_temp.elo_v2_restore_result values('History changed since activation (new games or corrections): ratings are a V1 replay of the current history');
 end if;
 insert into pg_temp.elo_v2_restore_result values('All restore checks passed');
end $$;
select result from pg_temp.elo_v2_restore_result;

select r.mode, p.username, round(f.rating::numeric,2) as v2_rating, round(r.rating::numeric,2) as v1_rating,
 round(r.rating::numeric-f.rating::numeric,2) as change, r.games, r.losses
from public.ratings r
join pg_temp.elo_v2_restore_from f on f.user_id=r.user_id and f.mode=r.mode
join public.profiles p on p.id=r.user_id
where r.games>0
order by r.mode, r.rating desc, p.username;

\if :commit
commit;
\echo 'Restored V1 and committed. elo_v2_backup is kept; drop it manually when no longer needed.'
\else
rollback;
\echo 'Rehearsal only: everything above was ROLLED BACK. Re-run with -v commit=on to restore.'
\endif
