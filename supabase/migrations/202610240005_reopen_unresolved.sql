-- Allow an unresolved historical game to be voted on again after later rounds.
-- Requires the table to be idle. Original round participants remain the only voters.
-- When the retroactive result is confirmed, private.finish_game calls
-- private.rebuild_mode, replaying all later Elo updates in chronological order.
create or replace function public.restart_unresolved(p_game uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  u uuid := private.current_user_id();
  g public.round_games%rowtype;
  t public.tables%rowtype;
begin
  select * into g
  from public.round_games
  where id = p_game
  for update;

  if not found or not private.is_round_player(g.round_id, u) then
    raise exception 'Not a participant in the original round';
  end if;
  if g.state <> 'unresolved' then
    raise exception 'Only unresolved ballots can be restarted';
  end if;

  select tb.* into t
  from public.rounds r
  join public.tables tb on tb.id = r.table_id
  where r.id = g.round_id
  for update of tb;

  if not found then
    raise exception 'Table not found';
  end if;
  if t.status <> 'lobby' or t.current_round_id is not null then
    raise exception 'Finish the active round before reopening an older vote';
  end if;
  if exists (
    select 1 from public.round_games x
    where x.round_id = g.round_id
      and x.id <> p_game
      and x.state not in ('confirmed', 'tied', 'unresolved', 'void')
  ) then
    raise exception 'Finish another active ballot in that round first';
  end if;

  update public.round_games
  set state = 'awaiting',
      finalized_at = null,
      deadline = null,
      loser_ids = '{}',
      allowed_nominees = null
  where id = p_game;

  update public.rounds
  set state = 'results', ended_at = null
  where id = g.round_id;

  delete from public.game_votes where game_id = p_game;
  delete from public.vote_totals where game_id = p_game;
  delete from public.tie_responses where game_id = p_game;

  update public.tables
  set status = 'results', current_round_id = g.round_id, updated_at = now()
  where id = t.id;
end $$;

