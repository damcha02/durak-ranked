-- Reputation stars: how honestly a player voted in their last 30 voted games.
--
-- The server never sees the cards, only the ballots, so dishonesty is read from two things the
-- group itself has settled:
--   denied_loss        the game's final result says you lost, but your ballot named someone else.
--                      (Single-loser results only: in a shared loss the vote itself was split.)
--   backed_overturned  a correction vote voided the game, your ballot named the player it had
--                      wrongly made the loser, and you did not approve that correction. Owning up
--                      to a mistake by approving the correction costs nothing, so nobody is put
--                      off fixing a wrong result. Voting for yourself is never counted here.
-- A minority vote on its own is not dishonest: people can disagree honestly.
--
-- Stars = 5 minus one per dishonest vote among the player's last 30 voted games (games with a
-- final result or voided by a correction, where they cast a ballot), never below 1. Older
-- votes drop out of the window, so stars recover. Nothing is stored: it is derived from
-- game_votes and round_games, so corrections and replays are reflected immediately.

create index if not exists game_votes_by_voter on public.game_votes(voter_id);

-- The player's last 30 voted games, newest first, with what their ballot means.
create or replace function private.reputation_window(p_user uuid)
returns table(game_id uuid, finalized_at timestamptz, mode public.durak_mode, kind text)
language sql stable security definer set search_path = '' as $$
 select w.id, w.finalized_at, w.mode,
  case
   when w.state='confirmed' and w.loser_ids=array[p_user] and w.nominee_id<>p_user then 'denied_loss'
   when w.state='void' and w.nominee_id<>p_user and w.nominee_id=any(w.loser_ids)
    and not exists(select 1 from public.reversal_cases c join public.reversal_votes rv on rv.case_id=c.id
                   where c.game_id=w.id and c.state='approved' and rv.user_id=p_user and rv.approve)
    then 'backed_overturned'
  end
 from (
  select g.id, g.state, g.loser_ids, g.finalized_at, t.mode, v.nominee_id
  from public.game_votes v
  join public.round_games g on g.id=v.game_id
  join public.rounds r on r.id=g.round_id
  join public.tables t on t.id=r.table_id
  where v.voter_id=p_user and g.state in ('confirmed','tied','void')
  order by g.finalized_at desc, g.id desc
  limit 30
 ) w
 order by w.finalized_at desc, w.id desc
$$;

-- Stars for any players (at most 100 per call); a player with no voted games has 5.
create or replace function public.player_reputation(p_users uuid[])
returns table(user_id uuid, stars int, dishonest int, voted int)
language sql stable security definer set search_path = '' as $$
 select u.id, greatest(1, 5 - s.dishonest)::int, s.dishonest, s.voted
 from (select distinct x as id from unnest(p_users[1:100]) x where x is not null) u
 cross join lateral (
  select count(*) filter (where w.kind is not null)::int as dishonest, count(*)::int as voted
  from private.reputation_window(u.id) w
 ) s
$$;

-- Your own dishonest votes still inside the window, newest first, so the profile can say why.
create or replace function public.my_reputation_events()
returns table(game_id uuid, finalized_at timestamptz, mode public.durak_mode, kind text)
language sql stable security definer set search_path = '' as $$
 select w.game_id, w.finalized_at, w.mode, w.kind
 from private.reputation_window(private.current_user_id()) w
 where w.kind is not null
$$;

revoke execute on function private.reputation_window(uuid) from public,anon,authenticated;
revoke execute on function public.player_reputation(uuid[]) from public,anon;
revoke execute on function public.my_reputation_events() from public,anon;
grant execute on function public.player_reputation(uuid[]) to authenticated;
grant execute on function public.my_reputation_events() to authenticated;
