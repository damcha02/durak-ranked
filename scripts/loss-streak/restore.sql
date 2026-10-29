-- Losing-streak penalty rollback: switch the rule off and replay every mode under plain Elo V2, in ONE transaction.
-- Ratings are restored by replaying the full history (not by copying old rows), so games played
-- after activation are kept and re-rated without the penalty. If the history is unchanged since
-- activation, the result must equal the loss_streak_backup snapshot exactly.
--
-- Rehearsal (default): does everything, prints the result, then ROLLS BACK.
--   psql "<connection>" -X -v ON_ERROR_STOP=1 -f scripts/loss-streak/restore.sql
-- Restore: same, but COMMITS when every check passes.
--   psql "<connection>" -X -v ON_ERROR_STOP=1 -v commit=on -f scripts/loss-streak/restore.sql
-- The backup schema is left in place; drop it manually once it is no longer needed.
\set ON_ERROR_STOP on
\if :{?commit}
\else
\set commit off
\endif

begin;
set local lock_timeout = '10s';
set local statement_timeout = '5min';
set local client_min_messages = warning;

do $$
begin
 if to_regclass('loss_streak_backup.ratings') is null or to_regclass('loss_streak_backup.meta') is null then
  raise exception 'No loss_streak_backup snapshot found';
 end if;
 if (select streak_rule from private.rating_config) = 'off' then
  raise exception 'The losing-streak penalty is not active; nothing to restore';
 end if;
 if (select formula from private.rating_config) <> 'v2' then
  raise exception 'Elo V2 is not active (formula=%)', (select formula from private.rating_config);
 end if;
end $$;

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
create temporary table streak_restore_from on commit drop as select * from public.ratings;
create temporary table streak_restore_result(result text) on commit drop;
insert into pg_temp.streak_restore_result
select format('Penalized games re-rated without the penalty: %s', count(distinct game_id)) from public.rating_ledger where streak_extra<0;

update private.rating_config set streak_rule='off', streak_from=null, updated_at=now();
select private.rebuild_mode(m) from unnest(enum_range(null::public.durak_mode)) as t(m);

select pg_temp.streak_checksum('after');
do $$
declare bad text; same_history boolean;
begin
 select string_agg(b.tbl,', ') into bad from pg_temp.streak_checksums b
  join pg_temp.streak_checksums a on a.tbl=b.tbl and a.phase='after'
  where b.phase='before' and (a.row_count,a.digest) is distinct from (b.row_count,b.digest);
 if bad is not null then raise exception 'Game/account tables changed: %', bad; end if;

 if exists(select g.id,rp.user_id from public.round_games g join public.round_players rp on rp.round_id=g.round_id
           where g.state in ('confirmed','tied') except select game_id,user_id from public.rating_ledger)
    or exists(select game_id,user_id from public.rating_ledger except
           select g.id,rp.user_id from public.round_games g join public.round_players rp on rp.round_id=g.round_id
           where g.state in ('confirmed','tied')) then
  raise exception 'Ledger does not have exactly one row per participant per rated game';
 end if;
 if exists(select 1 from public.rating_ledger group by game_id having sum(delta::numeric)<>0) then
  raise exception 'A game does not sum to exactly zero';
 end if;
 if exists(select 1 from public.ratings where loss_streak<>0)
    or exists(select 1 from public.rating_ledger where streak_extra<>0 or loss_streak is not null) then
  raise exception 'A streak or penalty is left after the restore';
 end if;

 select (select md5(coalesce(string_agg(md5(x::text),'' order by md5(x::text)),'')) from (
   select g.id,g.round_id,g.slot,g.state,g.loser_ids,g.finalized_at,r.started_at,t.mode,
    (select array_agg(rp.user_id order by rp.user_id) from public.round_players rp where rp.round_id=r.id) as roster
   from public.round_games g join public.rounds r on r.id=g.round_id join public.tables t on t.id=r.table_id) x)
  = (select history_digest from loss_streak_backup.meta) into same_history;
 if same_history then
  if exists(select user_id,mode,rating,games,losses from public.ratings except select user_id,mode,rating,games,losses from loss_streak_backup.ratings)
     or exists(select user_id,mode,rating,games,losses from loss_streak_backup.ratings except select user_id,mode,rating,games,losses from public.ratings)
     or exists(select game_id,user_id,delta from public.rating_ledger except select game_id,user_id,delta from loss_streak_backup.rating_ledger)
     or exists(select game_id,user_id,delta from loss_streak_backup.rating_ledger except select game_id,user_id,delta from public.rating_ledger) then
   raise exception 'Plain V2 replay differs from the backup';
  end if;
  insert into pg_temp.streak_restore_result values('History unchanged since activation: ratings equal the backup exactly');
 else
  insert into pg_temp.streak_restore_result values('History changed since activation: ratings are a plain V2 replay of the current history');
 end if;
 insert into pg_temp.streak_restore_result values('All restore checks passed');
end $$;
select result from pg_temp.streak_restore_result;

select r.mode, p.username, round(f.rating::numeric,2) as with_penalty, round(r.rating::numeric,2) as without_penalty,
 round(r.rating::numeric-f.rating::numeric,2) as change, f.loss_streak as streak_before, r.games, r.losses
from public.ratings r
join pg_temp.streak_restore_from f on f.user_id=r.user_id and f.mode=r.mode
join public.profiles p on p.id=r.user_id
where r.games>0 and (r.rating<>f.rating or f.loss_streak<>0)
order by r.mode, r.rating desc, p.username;

\if :commit
commit;
\echo 'Losing-streak penalty switched OFF and committed. loss_streak_backup is kept; drop it manually when no longer needed.'
\else
rollback;
\echo 'Rehearsal only: everything above was ROLLED BACK. Re-run with -v commit=on to restore.'
\endif
