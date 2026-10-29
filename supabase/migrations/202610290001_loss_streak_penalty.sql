-- Losing-streak penalty (rule 'loss_streak_v1'), an extension of Elo V2, shipped DISABLED.
-- Applying this migration changes no rating or ledger value: the rule defaults to 'off', and
-- with it off the V2 replay below produces exactly what the previous one did.
-- Activation is a separate, reviewed step (scripts/loss-streak/activate.sql); see docs/LOSS_STREAK.md.
--
-- The rule, per player and mode, across all tables:
-- * Every rated game (confirmed or tied) in replay order (rounds by started_at, id; games by slot)
--   is a loss for each player in loser_ids (a shared loss included) and a win for everyone else
--   at the table. A loss adds one to the player's consecutive-loss count; a win sets it to 0.
--   Unresolved, void and unfinished games are not rated, so they leave the count alone.
-- * A loss that is at least the 4th in a row costs 25% more: that loser's normal V2 delta is
--   multiplied by 1.25, and the extra is shared by the winners in proportion to their normal
--   gains. Other losers of a shared loss pay their normal amount. Ratings come from the
--   start-of-round snapshot as before, so both parallel games use it; the count moves per game.
-- * Only rounds started at or after rating_config.streak_from count. Earlier rounds keep plain
--   V2 and never touch the count, so every count is 0 at activation and no replay can apply
--   the penalty to an older game (a reopened old vote included).

alter table private.rating_config
 add column streak_rule text not null default 'off' check(streak_rule in ('off','loss_streak_v1')),
 add column streak_from timestamptz,
 add constraint rating_config_streak_from check((streak_rule='off')=(streak_from is null));

-- Consecutive losses in this mode as of the latest rated game (0 while the rule is off).
alter table public.ratings add column loss_streak int not null default 0 check(loss_streak>=0);
-- streak_extra: the part of delta that comes from a streak penalty (negative for the penalized
-- loser, positive for the winners' shares, 0 otherwise). loss_streak: the player's count after
-- this game; NULL for games the rule does not cover (before activation, or the rule off).
alter table public.rating_ledger
 add column streak_extra double precision not null default 0,
 add column loss_streak int;

-- One V2 game with the streak penalty applied to p_penalized (a subset of p_losers).
-- Starts from the normal V2 result in cents, then rounds the adjusted values with the same
-- largest-remainder rule as elo_v2_game_deltas (ties by md5(p_tiebreak || user_id)), so each
-- game sums to exactly 0.00. With nobody penalized the result equals elo_v2_game_deltas.
-- A penalized loser never pays less than normal, a winner never gains less than normal, and a
-- loser who is not penalized pays exactly the normal amount (a whole cent has no remainder).
create or replace function private.elo_streak_game_deltas(
 p_players uuid[], p_ratings numeric[], p_losers uuid[], p_k numeric, p_tiebreak text, p_penalized uuid[]
) returns table(user_id uuid, delta numeric, streak_extra numeric)
language plpgsql immutable set search_path = '' as $$
begin
 if p_penalized is null or array_position(p_penalized,null) is not null or not (p_penalized <@ p_losers) then
  raise exception 'Invalid streak penalty list';
 end if;
 return query
 with base as (
  select d.user_id as u, d.delta*100 as c from private.elo_v2_game_deltas(p_players,p_ratings,p_losers,p_k,p_tiebreak) d
 ), pool as (
  -- The extra deduction (25% of each penalized loss) and the normal winner gains it is shared by.
  select coalesce(sum(-b.c*0.25) filter(where b.u=any(p_penalized)),0) as extra,
   coalesce(sum(b.c) filter(where not b.u=any(p_losers)),0) as gains from base b
 ), raw as (
  select b.u, b.c as base,
   case when b.u=any(p_penalized) then b.c*1.25
        when b.u=any(p_losers) then b.c
        when pl.gains>0 then b.c+pl.extra*b.c/pl.gains
        else b.c end as cents
  from base b cross join pool pl
 ), floored as (
  select c.u, c.base, floor(c.cents) as f, c.cents-floor(c.cents) as frac
  from (select rw.u, rw.base, round(rw.cents,9) as cents from raw rw) c
 ), units as (
  select round(-sum(fl.f))::int as missing from floored fl
 ), ranked as (
  select fl.u, fl.base, fl.f, row_number() over (order by fl.frac desc, md5(coalesce(p_tiebreak,'')||fl.u::text) collate "C", fl.u) as rk from floored fl
 ), final as (
  select rk.u, rk.base, rk.f + case when rk.rk <= un.missing then 1 else 0 end as c from ranked rk cross join units un
 )
 select fi.u, round(fi.c/100,2), round((fi.c-fi.base)/100,2) from final fi order by fi.u;
end $$;

-- The V2 replay (same temp tables, same semantics), now also keeping each player's loss
-- streak and applying the penalty to rounds started at or after streak_from. With the rule
-- off every game goes through elo_v2_game_deltas exactly as before.
create or replace function private.elo_v2_replay(p_mode public.durak_mode, p_k numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare r record; g record; n int; ids uuid[]; rats numeric[]; streak_from timestamptz; penalized uuid[];
begin
 create temporary table if not exists elo_v2_ratings(
  user_id uuid primary key, rating numeric not null, games int not null, losses int not null,
  loss_streak int not null default 0) on commit drop;
 create temporary table if not exists elo_v2_ledger(
  game_id uuid not null, user_id uuid not null, delta numeric not null, recorded_at timestamptz not null,
  streak_extra numeric not null default 0, loss_streak int,
  primary key(game_id,user_id)) on commit drop;
 truncate table pg_temp.elo_v2_ratings, pg_temp.elo_v2_ledger;
 select case when c.streak_rule='loss_streak_v1' then c.streak_from end into streak_from from private.rating_config c;
 insert into pg_temp.elo_v2_ratings(user_id,rating,games,losses,loss_streak)
 select rat.user_id,1200,0,0,0 from public.ratings rat where rat.mode=p_mode;
 for r in
  select ro.id,ro.started_at from public.rounds ro join public.tables t on t.id=ro.table_id
  where t.mode=p_mode and exists(select 1 from public.round_games x where x.round_id=ro.id and x.state in ('confirmed','tied'))
  order by ro.started_at,ro.id
 loop
  select count(*) into n from public.round_players rp where rp.round_id=r.id;
  if n<3 then raise exception 'Invalid historical round with fewer than 3 players'; end if;
  select array_agg(s.user_id order by s.user_id),array_agg(s.rating order by s.user_id) into ids,rats
  from public.round_players rp join pg_temp.elo_v2_ratings s on s.user_id=rp.user_id
  where rp.round_id=r.id;
  if coalesce(cardinality(ids),0)<>n then raise exception 'Round player without a rating row in this mode'; end if;
  for g in
   select x.id,x.loser_ids,x.finalized_at from public.round_games x
   where x.round_id=r.id and x.state in ('confirmed','tied') order by x.slot
  loop
   if streak_from is null or r.started_at<streak_from then
    insert into pg_temp.elo_v2_ledger(game_id,user_id,delta,recorded_at)
    select g.id,d.user_id,d.delta,g.finalized_at from private.elo_v2_game_deltas(ids,rats,g.loser_ids,p_k,g.id::text) d;
   else
    -- Losers for whom this is at least the 4th loss in a row.
    select coalesce(array_agg(s.user_id order by s.user_id),'{}') into penalized
    from pg_temp.elo_v2_ratings s where s.user_id=any(g.loser_ids) and s.loss_streak+1>=4;
    insert into pg_temp.elo_v2_ledger(game_id,user_id,delta,recorded_at,streak_extra,loss_streak)
    select g.id,d.user_id,d.delta,g.finalized_at,d.streak_extra,
     case when d.user_id=any(g.loser_ids) then s.loss_streak+1 else 0 end
    from private.elo_streak_game_deltas(ids,rats,g.loser_ids,p_k,g.id::text,penalized) d
    join pg_temp.elo_v2_ratings s on s.user_id=d.user_id;
    -- Each game of a round moves the count on its own; ratings still change after the round.
    update pg_temp.elo_v2_ratings s set loss_streak=case when s.user_id=any(g.loser_ids) then s.loss_streak+1 else 0 end
    where s.user_id=any(ids);
   end if;
  end loop;
  update pg_temp.elo_v2_ratings s set rating=s.rating+x.total,games=s.games+x.played,losses=s.losses+x.lost
  from (
   select l.user_id,sum(l.delta) as total,count(*)::int as played,
    count(*) filter(where l.user_id=any(rg.loser_ids))::int as lost
   from pg_temp.elo_v2_ledger l join public.round_games rg on rg.id=l.game_id
   where rg.round_id=r.id group by l.user_id
  ) x
  where s.user_id=x.user_id;
 end loop;
end $$;

create or replace function private.rebuild_mode_v2(p_mode public.durak_mode) returns void
language plpgsql security definer set search_path = '' as $$
declare k numeric;
begin
 perform pg_advisory_xact_lock(hashtextextended('durak-rating-'||p_mode::text,0));
 select c.k into k from private.rating_config c;
 perform private.elo_v2_replay(p_mode,k);
 delete from public.rating_ledger where mode=p_mode;
 insert into public.rating_ledger(game_id,user_id,mode,delta,recorded_at,streak_extra,loss_streak)
 select l.game_id,l.user_id,p_mode,l.delta::double precision,l.recorded_at,l.streak_extra::double precision,l.loss_streak
 from pg_temp.elo_v2_ledger l order by l.game_id,l.user_id;
 update public.ratings rat set rating=s.rating::double precision,games=s.games,losses=s.losses,loss_streak=s.loss_streak
 from pg_temp.elo_v2_ratings s where rat.mode=p_mode and rat.user_id=s.user_id;
end $$;

-- V1 knows nothing of streaks: after a V1 rebuild no player in the mode has one.
create or replace function private.rebuild_mode(p_mode public.durak_mode) returns void
language plpgsql security definer set search_path = '' as $$
begin
 if (select c.formula from private.rating_config c)='v2' then
  perform private.rebuild_mode_v2(p_mode);
 else
  perform private.rebuild_mode_v1(p_mode);
  update public.ratings set loss_streak=0 where mode=p_mode and loss_streak<>0;
 end if;
end $$;

-- Game history with the streak penalty: the player's own count and penalty share, and whether
-- anyone at the game was penalized. The return type changes, so the function is recreated.
drop function public.my_game_history(uuid,int);
create function public.my_game_history(p_before uuid default null, p_limit int default 20)
returns table(game_id uuid, round_id uuid, mode public.durak_mode, slot int, games_in_round int,
 state public.game_state, played_at timestamptz, finalized_at timestamptz, player_count int,
 loser_ids uuid[], loser_names text[], delta numeric, rating_before numeric, rating_after numeric,
 correction text, loss_streak int, streak_extra numeric, streak_penalty boolean)
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
  (select c.state from public.reversal_cases c where c.game_id=x.id order by c.created_at desc limit 1),
  own.loss_streak, round(coalesce(own.streak_extra,0)::numeric,2),
  exists(select 1 from public.rating_ledger l where l.game_id=x.id and l.streak_extra<0)
 from private.player_history(private.current_user_id()) h
 join public.round_games x on x.id=h.game_id
 join public.rounds r on r.id=x.round_id
 join public.tables t on t.id=r.table_id
 left join public.rating_ledger own on own.game_id=x.id and own.user_id=private.current_user_id()
 where p_before is null
  or (r.started_at,r.id,x.slot) < (select c.started_at,c.round_id,c.slot from cursor_game c)
 order by r.started_at desc, r.id desc, x.slot desc
 limit least(greatest(coalesce(p_limit,20),1),100)
$$;

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
  'streak_penalty',exists(select 1 from public.rating_ledger l where l.game_id=x.id and l.streak_extra<0),
  'players',(
   select jsonb_agg(jsonb_build_object('user_id',rp.user_id,'username',p.username,'lost',rp.user_id=any(x.loser_ids),
     'delta',h.delta,'rating_before',h.rating_before,'rating_after',h.rating_after,
     'loss_streak',l.loss_streak,'streak_extra',round(coalesce(l.streak_extra,0)::numeric,2))
    order by rp.user_id=any(x.loser_ids) desc,h.delta desc nulls last,p.username)
   from public.round_players rp
   join public.profiles p on p.id=rp.user_id
   left join lateral (select ph.* from private.player_history(rp.user_id) ph where ph.game_id=x.id) h on true
   left join public.rating_ledger l on l.game_id=x.id and l.user_id=rp.user_id
   where rp.round_id=r.id))
 into result
 from public.round_games x join public.rounds r on r.id=x.round_id join public.tables t on t.id=r.table_id
 where x.id=p_game;
 return result;
end $$;

revoke execute on function private.elo_streak_game_deltas(uuid[],numeric[],uuid[],numeric,text,uuid[]) from public,anon,authenticated;
revoke execute on function private.elo_v2_replay(public.durak_mode,numeric) from public,anon,authenticated;
revoke execute on function private.rebuild_mode_v2(public.durak_mode) from public,anon,authenticated;
revoke execute on function private.rebuild_mode(public.durak_mode) from public,anon,authenticated;
revoke execute on function public.my_game_history(uuid,int) from public,anon;
revoke execute on function public.game_details(uuid) from public,anon;
grant execute on function public.my_game_history(uuid,int) to authenticated;
grant execute on function public.game_details(uuid) to authenticated;
