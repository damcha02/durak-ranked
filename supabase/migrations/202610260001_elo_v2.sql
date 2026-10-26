-- Elo V2: player-count-aware multiplayer rating, shipped DISABLED behind a switch.
-- Applying this migration changes no rating, ledger row or game record: the switch
-- defaults to 'v1' and the existing V1 replay is kept verbatim (renamed, not rewritten).
-- Activation (formula='v2' + replay of every mode) is a separate, reviewed step.
--
-- V2 model (see docs/ELO_V2_DESIGN.md). Each player's chance of being the Durak is
--   p_i = 10^(-R_i/400) / sum_j 10^(-R_j/400)
-- Winners gain K*p_i. The loser set T loses K*(1 - sum_T p) in total, split in
-- proportion to (1 - p_t); a sole loser therefore loses K*(1 - p_L). Zero-sum.

create table private.rating_config (
 id boolean primary key default true check(id),
 formula text not null default 'v1' check(formula in ('v1','v2')),
 k numeric not null default 20 check(k > 0 and k <= 64),
 updated_at timestamptz not null default now()
);
insert into private.rating_config default values;
alter table private.rating_config enable row level security;
revoke all on private.rating_config from public,anon,authenticated;

-- Pure per-game calculation. Arithmetic is numeric so results are identical on every
-- PostgreSQL build. Deltas are rounded to 0.01 by largest remainder, so each game sums to
-- exactly 0.00. Equal remainders are ordered by md5(p_tiebreak || user_id): deterministic,
-- but not always favouring the same users (replay passes the game id). Rows in user_id order.
create or replace function private.elo_v2_game_deltas(
 p_players uuid[], p_ratings numeric[], p_losers uuid[], p_k numeric, p_tiebreak text default ''
) returns table(user_id uuid, delta numeric)
language plpgsql immutable set search_path = '' as $$
declare n int := coalesce(cardinality(p_players),0); m int := coalesce(cardinality(p_losers),0);
begin
 if n < 2 or n <> coalesce(cardinality(p_ratings),0) or array_position(p_players,null) is not null
    or array_position(p_ratings,null) is not null or (select count(distinct x) from unnest(p_players) x) <> n then
  raise exception 'Invalid participants';
 end if;
 if m < 1 or m >= n or array_position(p_losers,null) is not null
    or (select count(distinct x) from unnest(p_losers) x) <> m or not (p_losers <@ p_players) then
  raise exception 'Invalid loser list';
 end if;
 if p_k is null or p_k <= 0 then raise exception 'Invalid K'; end if;
 return query
 with base as (
  -- Exponent relative to the strongest player keeps every term in [1, 10^(gap/400)].
  select t.u, power(10::numeric,(max(t.r) over () - t.r)/400) as g
  from unnest(p_players,p_ratings) as t(u,r)
 ), prob as (
  select b.u, b.g/sum(b.g) over () as p, b.u = any(p_losers) as lost from base b
 ), grp as (
  select sum(pr.p) filter(where pr.lost) as pt, sum(1-pr.p) filter(where pr.lost) as share from prob pr
 ), raw as (
  select pr.u, case when pr.lost then -p_k*(1-gr.pt)*(1-pr.p)/gr.share else p_k*pr.p end as d
  from prob pr cross join grp gr
 ), floored as (
  -- Work in cents snapped to 1e-9 so exact mathematical ties (equal ratings) stay ties.
  select c.u, floor(c.cents) as f, c.cents - floor(c.cents) as frac
  from (select rw.u, round(rw.d*100,9) as cents from raw rw) c
 ), units as (
  select round(-sum(fl.f))::int as missing from floored fl
 ), ranked as (
  select fl.u, fl.f, row_number() over (order by fl.frac desc, md5(coalesce(p_tiebreak,'')||fl.u::text) collate "C", fl.u) as rk from floored fl
 )
 select rk.u, round((rk.f + case when rk.rk <= un.missing then 1 else 0 end)/100,2)
 from ranked rk cross join units un
 order by rk.u;
end $$;

-- Replays one mode under V2 into transaction-local temp tables only:
--   pg_temp.elo_v2_ratings(user_id, rating, games, losses)
--   pg_temp.elo_v2_ledger(game_id, user_id, delta, recorded_at)
-- Same semantics as V1: rounds in (started_at, id) order, only confirmed/tied games,
-- the full locked round roster plays every game of the round, and every game of a
-- round is rated from the start-of-round snapshot (deltas are applied after the round).
create or replace function private.elo_v2_replay(p_mode public.durak_mode, p_k numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare r record; g record; n int; ids uuid[]; rats numeric[];
begin
 create temporary table if not exists elo_v2_ratings(
  user_id uuid primary key, rating numeric not null, games int not null, losses int not null) on commit drop;
 create temporary table if not exists elo_v2_ledger(
  game_id uuid not null, user_id uuid not null, delta numeric not null, recorded_at timestamptz not null,
  primary key(game_id,user_id)) on commit drop;
 truncate table pg_temp.elo_v2_ratings, pg_temp.elo_v2_ledger;
 insert into pg_temp.elo_v2_ratings(user_id,rating,games,losses)
 select rat.user_id,1200,0,0 from public.ratings rat where rat.mode=p_mode;
 for r in
  select ro.id from public.rounds ro join public.tables t on t.id=ro.table_id
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
   insert into pg_temp.elo_v2_ledger(game_id,user_id,delta,recorded_at)
   select g.id,d.user_id,d.delta,g.finalized_at from private.elo_v2_game_deltas(ids,rats,g.loser_ids,p_k,g.id::text) d;
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
 -- Same per-mode lock key as V1, so V1 and V2 rebuilds of a mode never interleave.
 perform pg_advisory_xact_lock(hashtextextended('durak-rating-'||p_mode::text,0));
 select c.k into k from private.rating_config c;
 perform private.elo_v2_replay(p_mode,k);
 delete from public.rating_ledger where mode=p_mode;
 insert into public.rating_ledger(game_id,user_id,mode,delta,recorded_at)
 select l.game_id,l.user_id,p_mode,l.delta::double precision,l.recorded_at
 from pg_temp.elo_v2_ledger l order by l.game_id,l.user_id;
 update public.ratings rat set rating=s.rating::double precision,games=s.games,losses=s.losses
 from pg_temp.elo_v2_ratings s where rat.mode=p_mode and rat.user_id=s.user_id;
end $$;

-- Keep the deployed V1 body byte-for-byte by renaming it; callers (finish_game,
-- vote_reversal) keep calling private.rebuild_mode, which now dispatches on the switch.
alter function private.rebuild_mode(public.durak_mode) rename to rebuild_mode_v1;
create function private.rebuild_mode(p_mode public.durak_mode) returns void
language plpgsql security definer set search_path = '' as $$
begin
 if (select c.formula from private.rating_config c)='v2' then
  perform private.rebuild_mode_v2(p_mode);
 else
  perform private.rebuild_mode_v1(p_mode);
 end if;
end $$;

-- Read-only dry run: replays a mode under V2 into temp tables and compares it with the
-- stored ratings. Writes nothing outside pg_temp. Equal ratings share a rank.
create or replace function private.elo_v2_preview(p_mode public.durak_mode)
returns table(user_id uuid, username text, mode public.durak_mode, current_rating double precision,
 v2_rating numeric, difference numeric, games int, losses int, current_rank bigint, v2_rank bigint)
language plpgsql security definer set search_path = '' as $$
declare k numeric;
begin
 select c.k into k from private.rating_config c;
 perform private.elo_v2_replay(p_mode,k);
 return query
 select rat.user_id,pr.username,p_mode,rat.rating,s.rating,
  round(s.rating-rat.rating::numeric,2),s.games,s.losses,
  rank() over (order by rat.rating desc),rank() over (order by s.rating desc)
 from public.ratings rat
 join public.profiles pr on pr.id=rat.user_id
 join pg_temp.elo_v2_ratings s on s.user_id=rat.user_id
 where rat.mode=p_mode and (rat.games>0 or s.games>0)
 order by s.rating desc,pr.username;
end $$;

revoke execute on function private.elo_v2_game_deltas(uuid[],numeric[],uuid[],numeric,text) from public,anon,authenticated;
revoke execute on function private.elo_v2_replay(public.durak_mode,numeric) from public,anon,authenticated;
revoke execute on function private.rebuild_mode_v2(public.durak_mode) from public,anon,authenticated;
revoke execute on function private.rebuild_mode(public.durak_mode) from public,anon,authenticated;
revoke execute on function private.elo_v2_preview(public.durak_mode) from public,anon,authenticated;
