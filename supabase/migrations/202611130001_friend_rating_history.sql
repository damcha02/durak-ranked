-- A friend's rating chart: the same rows as public.my_rating_history, for another player, readable
-- only by yourself or an accepted friend. Read-only; nothing is re-rated or written here.
create or replace function public.friend_rating_history(p_user uuid,p_mode public.durak_mode)
returns table(game_id uuid, round_id uuid, slot int, games_in_round int, state public.game_state,
 played_at timestamptz, finalized_at timestamptz, delta numeric, rating_before numeric, rating_after numeric)
language plpgsql stable security definer set search_path = '' as $$
declare uid uuid:=private.current_user_id();
begin
 if p_user is null or (p_user<>uid and not private.are_friends(uid,p_user)) then
  raise exception 'You can only see the rating history of your friends';
 end if;
 return query
 select x.id, r.id, x.slot,
  (select count(*)::int from public.round_games y where y.round_id=r.id),
  x.state, r.started_at, x.finalized_at, h.delta, h.rating_before, h.rating_after
 from private.player_history(p_user) h
 join public.round_games x on x.id=h.game_id
 join public.rounds r on r.id=x.round_id
 join public.tables t on t.id=r.table_id
 where t.mode=p_mode and x.state in ('confirmed','tied')
 order by r.started_at, r.id, x.slot;
end $$;

revoke execute on function public.friend_rating_history(uuid,public.durak_mode) from public,anon;
grant execute on function public.friend_rating_history(uuid,public.durak_mode) to authenticated;
