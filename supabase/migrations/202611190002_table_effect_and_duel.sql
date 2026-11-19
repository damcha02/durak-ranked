-- Head-to-head statistics, read-only over the same rated games as the rating chart
-- (private.player_history, confirmed or tied). A shared loss counts as a loss for everyone in it.

-- Profile → "Who's at the table": for every player the signed-in user shared a rated game with,
-- how often the user lost with them at the table, and how often they'd lose if everyone were equal
-- (expected_losses = the sum of 1/players over those games, so table sizes are accounted for).
create or replace function public.my_table_effect(p_mode public.durak_mode)
returns table(user_id uuid, username text, games int, losses int, expected_losses numeric)
language sql stable security definer set search_path = '' as $$
 with mine as (
  select x.id, x.round_id, private.current_user_id()=any(x.loser_ids) as lost,
   1.0/(select count(*) from public.round_players rp where rp.round_id=x.round_id) as fair
  from private.player_history(private.current_user_id()) h
  join public.round_games x on x.id=h.game_id
  join public.rounds r on r.id=x.round_id
  join public.tables t on t.id=r.table_id
  where t.mode=p_mode and x.state in ('confirmed','tied')
 )
 select o.user_id, p.username, count(*)::int, count(*) filter (where m.lost)::int, round(sum(m.fair),4)
 from mine m
 join public.round_players o on o.round_id=m.round_id and o.user_id<>private.current_user_id()
 join public.profiles p on p.id=o.user_id
 group by o.user_id, p.username
 order by count(*) desc, p.username
$$;

-- Friends → "Duel": the signed-in user against one accepted friend, over the rated games both played.
create or replace function public.duel_stats(p_friend uuid, p_mode public.durak_mode)
returns table(games int, my_losses int, their_losses int, both_lost int)
language plpgsql stable security definer set search_path = '' as $$
declare uid uuid:=private.current_user_id();
begin
 if p_friend is null or p_friend=uid or not private.are_friends(uid,p_friend) then
  raise exception 'You can only compare yourself with your friends';
 end if;
 return query
 select count(*)::int,
  count(*) filter (where uid=any(x.loser_ids))::int,
  count(*) filter (where p_friend=any(x.loser_ids))::int,
  count(*) filter (where uid=any(x.loser_ids) and p_friend=any(x.loser_ids))::int
 from private.player_history(uid) h
 join public.round_games x on x.id=h.game_id
 join public.rounds r on r.id=x.round_id
 join public.tables t on t.id=r.table_id
 where t.mode=p_mode and x.state in ('confirmed','tied')
  and exists (select 1 from public.round_players rp where rp.round_id=x.round_id and rp.user_id=p_friend);
end $$;

revoke execute on function public.my_table_effect(public.durak_mode) from public,anon;
grant execute on function public.my_table_effect(public.durak_mode) to authenticated;
revoke execute on function public.duel_stats(uuid,public.durak_mode) from public,anon;
grant execute on function public.duel_stats(uuid,public.durak_mode) to authenticated;
