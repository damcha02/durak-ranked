-- Profile → Statistics "Expected vs. actual losses": for the signed-in player's rated games in one
-- mode, grouped by round size, the losses Elo expected against the losses that happened.
-- Expected: the Elo V2 chance of being the Durak, p_i = 10^(-R_i/400) / sum_j 10^(-R_j/400) (the same
-- formula as the losing chance at the table), from every player's rating at the start of the round.
-- That rating is the replayed ledger balance before the round's first game (private.player_history),
-- not round_players.rating_at_start: that snapshot is missing for older rounds and isn't corrected
-- when a reversal re-rates the mode. A shared loss counts as 1/(number of players sharing it), so
-- expected and actual both add up to one loss per game. Read-only; nothing is re-rated or written.
create or replace function public.my_expected_losses(p_mode public.durak_mode)
returns table(player_count int, games int, losses numeric, expected_losses numeric)
language sql stable security definer set search_path = '' as $$
 with mine as (
  select x.id, x.round_id, x.loser_ids
  from private.player_history(private.current_user_id()) h
  join public.round_games x on x.id=h.game_id
  join public.rounds r on r.id=x.round_id
  join public.tables t on t.id=r.table_id
  where t.mode=p_mode and x.state in ('confirmed','tied')
 ),
 people as (
  select distinct rp.user_id from mine m join public.round_players rp on rp.round_id=m.round_id
 ),
 hist as (
  select p.user_id, ph.game_id, ph.rating_before
  from people p cross join lateral private.player_history(p.user_id) ph
 ),
 seat as (
  select m.id, rp.user_id, hi.rating_before as r
  from mine m
  join public.round_players rp on rp.round_id=m.round_id
  join public.round_games g1 on g1.round_id=m.round_id and g1.slot=1
  join hist hi on hi.user_id=rp.user_id and hi.game_id=g1.id
 ),
 prob as (
  -- Exponent relative to the strongest player keeps every term in [1, 10^(gap/400)].
  select s.id, s.user_id, count(*) over (partition by s.id) as n,
   power(10::numeric,(max(s.r) over (partition by s.id)-s.r)/400) as g
  from seat s
 ),
 game as (
  select p.id, p.user_id, p.n, p.g/sum(p.g) over (partition by p.id) as p from prob p
 )
 select gm.n::int, count(*)::int,
  round(sum(case when private.current_user_id()=any(m.loser_ids) then 1.0/cardinality(m.loser_ids) else 0 end),4),
  round(sum(gm.p),4)
 from game gm join mine m on m.id=gm.id
 where gm.user_id=private.current_user_id()
 group by gm.n order by gm.n
$$;

revoke execute on function public.my_expected_losses(public.durak_mode) from public,anon;
grant execute on function public.my_expected_losses(public.durak_mode) to authenticated;
