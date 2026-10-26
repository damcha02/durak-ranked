-- Elo V2 status check. READ-ONLY: one read-only transaction, rolled back.
--   psql "<connection>" -X -v ON_ERROR_STOP=1 -f scripts/elo-v2/status.sql
begin transaction read only;
select formula, k, updated_at from private.rating_config;
select n.nspname||'.'||p.proname as elo_function
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='private' and (p.proname like 'elo_v2%' or p.proname like 'rebuild_mode%')
order by 1;
select to_regnamespace('elo_v2_backup') is not null as backup_exists;
select r.mode, p.username, r.rating, r.games, r.losses
from public.ratings r join public.profiles p on p.id=r.user_id
where r.games>0 order by r.mode, r.rating desc;
rollback;
