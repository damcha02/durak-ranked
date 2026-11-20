-- One round trip per screen load instead of a chain of dependent queries.
--
-- The table screen used to make up to ten requests per reload (most of them waiting on the one
-- before), on every vote and every 15-second refresh; Home made four, every 12 seconds. These
-- functions return the same data as one JSON document.
--
-- Both are SECURITY INVOKER (the default): they run as the signed-in caller, so every row-level
-- security policy applies exactly as it does to the old direct queries. They cannot show anyone
-- more than those queries did; e.g. individual ballots stay hidden until a game's result is final.

-- Everything the table screen shows, or null when the caller cannot see the table.
create or replace function public.table_state(p_table uuid) returns jsonb
language sql stable set search_path = '' as $$
 with t as (select * from public.tables where id = p_table),
 mem as (select * from public.table_members where table_id = p_table and is_active),
 rnd as (select id from public.rounds where table_id = p_table order by started_at desc limit 12),
 rp as (select * from public.round_players where round_id = (select current_round_id from t)),
 cur as (select * from public.round_games where round_id = (select current_round_id from t)),
 hist as (
  select * from public.round_games where round_id in (select id from rnd)
  order by finalized_at desc limit 24
 ),
 ballots as (select game_id, voter_id, nominee_id from public.game_votes where game_id in (select id from hist)),
 rc as (select * from public.reversal_cases where game_id in (select id from hist)),
 people as (
  select user_id as id from mem
  union select user_id from rp
  union select unnest(loser_ids) from hist
  union select voter_id from ballots
  union select nominee_id from ballots
 )
 select case when not exists (select 1 from t) then null else jsonb_build_object(
  'table', (select to_jsonb(t) from t),
  'members', coalesce((select jsonb_agg(to_jsonb(m) order by m.joined_at) from mem m), '[]'),
  'round_ids', coalesce((select jsonb_agg(id) from rnd), '[]'),
  'players', coalesce((select jsonb_agg(user_id) from rp), '[]'),
  'games', coalesce((select jsonb_agg(to_jsonb(g) order by g.slot) from cur g), '[]'),
  'history', coalesce((select jsonb_agg(to_jsonb(h) order by h.finalized_at desc) from hist h), '[]'),
  'totals', coalesce((select jsonb_agg(to_jsonb(v)) from public.vote_totals v where v.game_id in (select id from cur)), '[]'),
  'ballots', coalesce((select jsonb_agg(to_jsonb(b)) from ballots b), '[]'),
  'cases', coalesce((select jsonb_agg(to_jsonb(c)) from rc c), '[]'),
  'case_approvals', coalesce((
   select jsonb_object_agg(case_id, n) from (
    select v.case_id, count(*) as n from public.reversal_votes v
    where v.approve and v.case_id in (select id from rc where state = 'open') group by v.case_id
   ) a), '{}'),
  'profiles', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'username', p.username))
   from public.profiles p where p.id in (select id from people)), '[]'),
  -- Losing chance: live ratings of whoever is seated in the lobby; once the round is locked, the
  -- ratings stored when it started. None while results are being recorded.
  'chance', case (select status from t)
   when 'lobby' then coalesce((select jsonb_agg(jsonb_build_object('user_id', r.user_id, 'rating', r.rating))
    from public.ratings r where r.mode = (select mode from t) and r.user_id in (select user_id from mem)), '[]')
   when 'playing' then coalesce((select jsonb_agg(jsonb_build_object('user_id', user_id, 'rating', rating_at_start)) from rp), '[]')
  end,
  -- The host's friends, offered as one-tap seats while the table is an open lobby.
  'friends', case when (select host_id = auth.uid() and status = 'lobby' and closed_at is null from t) then
   coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.username))
    from public.friendships f
    join public.profiles p on p.id = case when f.user_a = auth.uid() then f.user_b else f.user_a end
    where f.status = 'accepted'), '[]')
  end
 ) end
 from (select 1) one
$$;

-- Home: your tables (open ones, and closed ones since p_closed_after), who sits at each, and your ratings.
create or replace function public.home_state(p_closed_after timestamptz) returns jsonb
language sql stable set search_path = '' as $$
 with mine as (
  select t.* from public.tables t
  where t.id in (select table_id from public.table_members where user_id = auth.uid() and is_active)
   and (t.closed_at is null or t.closed_at > p_closed_after)
 )
 select jsonb_build_object(
  'tables', coalesce((select jsonb_agg(to_jsonb(t) order by t.created_at desc) from mine t), '[]'),
  'ratings', coalesce((select jsonb_agg(to_jsonb(r)) from public.ratings r where r.user_id = auth.uid()), '[]'),
  'seated', coalesce((
   select jsonb_agg(jsonb_build_object('table_id', m.table_id, 'id', m.user_id, 'name', coalesce(p.username, 'Player'))
    order by m.joined_at)
   from public.table_members m left join public.profiles p on p.id = m.user_id
   where m.table_id in (select id from mine) and m.is_active), '[]')
 )
$$;

revoke execute on function public.table_state(uuid) from public, anon;
revoke execute on function public.home_state(timestamptz) from public, anon;
grant execute on function public.table_state(uuid) to authenticated;
grant execute on function public.home_state(timestamptz) to authenticated;
