-- Personal game history (History tab): read-only RPCs over the authoritative records.
-- Results come from round_games, rating changes from rating_ledger; nothing is re-rated here.
-- A player's Elo before/after a game is 1200 plus their ledger deltas in that mode, summed
-- in the order the rating replay applies them (rounds by started_at, id; games by slot), so
-- the last value always equals public.ratings. Both games of a parallel round are rated from
-- the start-of-round rating; their before/after values are the running balance in slot order.
-- Void (corrected) and unresolved games have no ledger rows and show a change of 0.

-- Participant-only ledger. Until now every signed-in user could read every row; the app only
-- reads its own rows (Profile), and co-players of a game may see that game's changes.
drop policy ledger_read on public.rating_ledger;
create policy ledger_read on public.rating_ledger for select to authenticated using (
 user_id=(select auth.uid()) or private.is_game_player(game_id,(select auth.uid())));

-- Every game with a result state the user played, with their change and running rating.
create or replace function private.player_history(p_user uuid)
returns table(game_id uuid, delta numeric, rating_before numeric, rating_after numeric)
language sql stable security definer set search_path = '' as $$
 with g as (
  select x.id, t.mode, r.started_at, r.id as round_id, x.slot, coalesce(l.delta::numeric,0) as d
  from public.round_players rp
  join public.rounds r on r.id=rp.round_id
  join public.tables t on t.id=r.table_id
  join public.round_games x on x.round_id=r.id
  left join public.rating_ledger l on l.game_id=x.id and l.user_id=rp.user_id
  where rp.user_id=p_user and x.state in ('confirmed','tied','void','unresolved')
 )
 select g.id, round(g.d,2), round(1200+sum(g.d) over w-g.d,2), round(1200+sum(g.d) over w,2)
 from g
 window w as (partition by g.mode order by g.started_at,g.round_id,g.slot rows between unbounded preceding and current row)
$$;

-- The signed-in player's games, newest first in replay order. Pass the last game id of a
-- page as p_before for the next (older) page.
create or replace function public.my_game_history(p_before uuid default null, p_limit int default 20)
returns table(game_id uuid, round_id uuid, mode public.durak_mode, slot int, games_in_round int,
 state public.game_state, played_at timestamptz, finalized_at timestamptz, player_count int,
 loser_ids uuid[], loser_names text[], delta numeric, rating_before numeric, rating_after numeric,
 correction text)
language sql stable security definer set search_path = '' as $$
 with cursor_game as (
  select r.started_at, r.id as round_id, x.slot from public.round_games x join public.rounds r on r.id=x.round_id
  where x.id=p_before
 )
 select x.id, r.id, t.mode, x.slot,
  (select count(*)::int from public.round_games y where y.round_id=r.id),
  x.state, r.started_at, x.finalized_at,
  (select count(*)::int from public.round_players rp where rp.round_id=r.id),
  x.loser_ids,
  array(select p.username from unnest(x.loser_ids) with ordinality as u(id,o) join public.profiles p on p.id=u.id order by u.o),
  h.delta, h.rating_before, h.rating_after,
  (select c.state from public.reversal_cases c where c.game_id=x.id order by c.created_at desc limit 1)
 from private.player_history(private.current_user_id()) h
 join public.round_games x on x.id=h.game_id
 join public.rounds r on r.id=x.round_id
 join public.tables t on t.id=r.table_id
 where p_before is null
  or (r.started_at,r.id,x.slot) < (select c.started_at,c.round_id,c.slot from cursor_game c)
 order by r.started_at desc, r.id desc, x.slot desc
 limit least(greatest(coalesce(p_limit,20),1),100)
$$;

-- One game in full, for its participants only: every player's change and rating before/after.
create or replace function public.game_details(p_game uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare uid uuid:=private.current_user_id(); result jsonb;
begin
 if p_game is null or not private.is_game_player(p_game,uid) then raise exception 'Not a participant'; end if;
 select jsonb_build_object(
  'game_id',x.id,'mode',t.mode,'slot',x.slot,
  'games_in_round',(select count(*) from public.round_games y where y.round_id=r.id),
  'state',x.state,'played_at',r.started_at,'finalized_at',x.finalized_at,'loser_ids',to_jsonb(x.loser_ids),
  'correction',(select c.state from public.reversal_cases c where c.game_id=x.id order by c.created_at desc limit 1),
  'players',(
   select jsonb_agg(jsonb_build_object('user_id',rp.user_id,'username',p.username,'lost',rp.user_id=any(x.loser_ids),
     'delta',h.delta,'rating_before',h.rating_before,'rating_after',h.rating_after)
    order by rp.user_id=any(x.loser_ids) desc,h.delta desc nulls last,p.username)
   from public.round_players rp
   join public.profiles p on p.id=rp.user_id
   left join lateral (select ph.* from private.player_history(rp.user_id) ph where ph.game_id=x.id) h on true
   where rp.round_id=r.id))
 into result
 from public.round_games x join public.rounds r on r.id=x.round_id join public.tables t on t.id=r.table_id
 where x.id=p_game;
 return result;
end $$;

revoke execute on function private.player_history(uuid) from public,anon,authenticated;
revoke execute on function public.my_game_history(uuid,int) from public,anon;
revoke execute on function public.game_details(uuid) from public,anon;
grant execute on function public.my_game_history(uuid,int) to authenticated;
grant execute on function public.game_details(uuid) to authenticated;
