-- Profile → Statistics "By number of players": the signed-in player's rated games in one mode,
-- grouped by how many players were in the round. Read-only, built on private.player_history like
-- the rating chart, so the Elo change is the same ledger the History tab shows. Only rated games
-- count (confirmed or tied); a shared loss (tied) counts as a loss, as it does in public.ratings.
create or replace function public.my_player_count_stats(p_mode public.durak_mode)
returns table(player_count int, games int, losses int, elo_change numeric)
language sql stable security definer set search_path = '' as $$
 with mine as (
  select x.id, x.loser_ids, h.delta,
   (select count(*)::int from public.round_players rp where rp.round_id=x.round_id) as n
  from private.player_history(private.current_user_id()) h
  join public.round_games x on x.id=h.game_id
  join public.rounds r on r.id=x.round_id
  join public.tables t on t.id=r.table_id
  where t.mode=p_mode and x.state in ('confirmed','tied')
 )
 select n, count(*)::int,
  count(*) filter (where private.current_user_id()=any(loser_ids))::int,
  round(sum(delta),2)
 from mine group by n order by n
$$;

revoke execute on function public.my_player_count_stats(public.durak_mode) from public,anon;
grant execute on function public.my_player_count_stats(public.durak_mode) to authenticated;
