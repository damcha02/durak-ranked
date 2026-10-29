-- Rating over time (Profile chart): the signed-in player's rated games in one mode, read-only.
-- Rows come from private.player_history, so every value is the same running ledger balance the
-- History tab shows, in the order the rating replay applies the games (rounds by started_at, id;
-- games by slot) and ending at public.ratings. Only rated games are listed (confirmed or tied):
-- a game reversed by a correction (void) or without a result (unresolved) has no rating change,
-- and the replay has already re-rated everything after it. Nothing is re-rated or written here.
create or replace function public.my_rating_history(p_mode public.durak_mode)
returns table(game_id uuid, round_id uuid, slot int, games_in_round int, state public.game_state,
 played_at timestamptz, finalized_at timestamptz, delta numeric, rating_before numeric, rating_after numeric)
language sql stable security definer set search_path = '' as $$
 select x.id, r.id, x.slot,
  (select count(*)::int from public.round_games y where y.round_id=r.id),
  x.state, r.started_at, x.finalized_at, h.delta, h.rating_before, h.rating_after
 from private.player_history(private.current_user_id()) h
 join public.round_games x on x.id=h.game_id
 join public.rounds r on r.id=x.round_id
 join public.tables t on t.id=r.table_id
 where t.mode=p_mode and x.state in ('confirmed','tied')
 order by r.started_at, r.id, x.slot
$$;

revoke execute on function public.my_rating_history(public.durak_mode) from public,anon;
grant execute on function public.my_rating_history(public.durak_mode) to authenticated;
