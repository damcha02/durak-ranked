-- Losing-streak penalty status check. READ-ONLY: one read-only transaction, rolled back.
--   psql "<connection>" -X -v ON_ERROR_STOP=1 -f scripts/loss-streak/status.sql
begin transaction read only;
select formula, k, streak_rule, streak_from, updated_at from private.rating_config;
select to_regnamespace('loss_streak_backup') is not null as backup_exists;
select count(distinct game_id) filter(where streak_extra<0) as penalized_games, coalesce(sum(-streak_extra) filter(where streak_extra<0),0) as total_extra_elo
from public.rating_ledger;
select r.mode, p.username, r.loss_streak, r.rating
from public.ratings r join public.profiles p on p.id=r.user_id
where r.loss_streak>0 order by r.mode, r.loss_streak desc, p.username;
rollback;
