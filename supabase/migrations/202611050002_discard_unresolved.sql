-- A vote that ends without a loser is discarded instead of being kept as "unresolved".
--
-- A game becomes unresolved only when no player got at least 2 votes (a single vote is not a
-- verdict). Such games used to stay forever, could be voted on again, and kept their table
-- open indefinitely. Now the game is deleted when its vote expires: nothing was rated, so
-- ratings are untouched. If it was the round's only game, the round goes too and the table is
-- back in the lobby; in a parallel round the other game carries on.
--
-- Existing unresolved games are deleted the same way (they have no ledger rows), so the tables
-- they held open can expire.

create or replace function private.discard_game(p_game uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare g public.round_games%rowtype; t_id uuid; open_games int;
begin
 select * into g from public.round_games where id=p_game;
 if not found then return; end if;
 select table_id into t_id from public.rounds where id=g.round_id;
 delete from public.round_games where id=p_game; -- votes, totals and tie responses cascade
 select count(*) filter (where state not in ('confirmed','tied','unresolved','void')) into open_games
 from public.round_games where round_id=g.round_id;
 if not exists(select 1 from public.round_games where round_id=g.round_id) then
  update public.tables set status='lobby',current_round_id=null,updated_at=now()
  where id=t_id and current_round_id=g.round_id;
  delete from public.rounds where id=g.round_id;
 elsif open_games=0 then
  update public.rounds set state='done',ended_at=now() where id=g.round_id;
  update public.tables set status='lobby',current_round_id=null,updated_at=now()
  where id=t_id and current_round_id=g.round_id;
 end if;
 update public.tables set updated_at=now() where id=t_id;
 perform private.touch_table(t_id);
end $$;

-- Same as before except the "no verdict" branch, which discards the game.
create or replace function private.expire_or_resolve(p_game uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare g public.round_games%rowtype; n int; leader uuid; best int; top_count int; tied uuid[];
begin
 select * into g from public.round_games where id=p_game for update;
 if not found then raise exception 'Game missing'; end if;
 if g.state='tie_offer' then
  if g.deadline>now() then return; end if;
  update public.round_games set state='voting',deadline=now()+interval '30 seconds',allowed_nominees=g.loser_ids,loser_ids='{}' where id=p_game;
  delete from public.game_votes where game_id=p_game;
  delete from public.vote_totals where game_id=p_game;
  return;
 end if;
 if g.state<>'voting' then return; end if;
 select count(*) into n from public.round_players where round_id=g.round_id;
 select nominee_id,votes into leader,best from public.vote_totals where game_id=p_game order by votes desc,nominee_id limit 1;
 if best is not null and best > n/2 then
  perform private.finish_game(p_game,array[leader],false); return;
 end if;
 if g.deadline>now() then return; end if;
 if coalesce(best,0)<2 then
  perform private.discard_game(p_game); return;
 end if;
 select array_agg(nominee_id order by nominee_id),count(*) into tied,top_count from public.vote_totals where game_id=p_game and votes=best;
 if top_count=1 then
  perform private.finish_game(p_game,array[leader],false);
 else
  update public.round_games set state='tie_offer',loser_ids=tied,allowed_nominees=tied,deadline=now()+interval '30 seconds' where id=p_game;
  delete from public.tie_responses where game_id=p_game;
 end if;
end $$;

-- Existing games without a result.
delete from public.round_games where state='unresolved';
delete from public.rounds r where not exists(select 1 from public.round_games g where g.round_id=r.id);

revoke execute on function private.discard_game(uuid) from public,anon,authenticated;
