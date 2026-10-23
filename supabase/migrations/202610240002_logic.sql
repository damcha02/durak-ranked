-- Exposed RPCs are SECURITY DEFINER because only the server may mutate shared game state.
-- Every RPC checks auth.uid() and access before changing records. Never expose service-role keys.
create or replace function private.current_user_id() returns uuid
language plpgsql stable security invoker set search_path = '' as $$
declare u uuid;
begin
 u := (select auth.uid());
 if u is null then raise exception 'Please sign in first'; end if;
 return u;
end $$;
create or replace function private.new_code() returns text
language sql volatile set search_path = '' as $$
 select upper(substr(replace(gen_random_uuid()::text,'-',''),1,8))
$$;

create or replace function public.set_username(p_username text) returns void
language plpgsql security definer set search_path = '' as $$
begin
 if p_username !~ '^[a-zA-Z0-9_]{3,22}$' then raise exception 'Username must be 3–22 letters, digits or underscores'; end if;
 update public.profiles set username=p_username where id=private.current_user_id();
end $$;

create or replace function public.create_friend_group(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare uid uuid:=private.current_user_id(); gid uuid;
begin
 if length(trim(p_name)) not between 2 and 60 then raise exception 'Group name must be 2–60 characters'; end if;
 insert into public.friend_groups(name,code,owner_id) values(trim(p_name),private.new_code(),uid) returning id into gid;
 insert into public.group_members(group_id,user_id) values(gid,uid);
 return gid;
end $$;
create or replace function public.join_friend_group(p_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare uid uuid:=private.current_user_id(); gid uuid;
begin
 select id into gid from public.friend_groups where code=upper(trim(p_code));
 if gid is null then raise exception 'Group not found'; end if;
 insert into public.group_members(group_id,user_id) values(gid,uid) on conflict do nothing;
 return gid;
end $$;
create or replace function public.create_table(p_mode public.durak_mode default 'natural',p_group uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare uid uuid:=private.current_user_id(); tid uuid;
begin
 if p_group is not null and not private.is_group_member(p_group,uid) then raise exception 'Not a member of that group'; end if;
 insert into public.tables(code,mode,group_id,host_id) values(private.new_code(),p_mode,p_group,uid) returning id into tid;
 insert into public.table_members(table_id,user_id) values(tid,uid);
 return tid;
end $$;
create or replace function public.join_table(p_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare uid uuid:=private.current_user_id(); t public.tables%rowtype; n int; max_n int;
begin
 select * into t from public.tables where code=upper(trim(p_code)) for update;
 if not found then raise exception 'Table not found'; end if;
 if t.status<>'lobby' then raise exception 'Game already started. Join between games.'; end if;
 max_n:=case when t.mode in ('natural','single_double') then 8 else 16 end;
 select count(*) into n from public.table_members where table_id=t.id and is_active;
 if n>=max_n and not private.is_table_member(t.id,uid) then raise exception 'Table is full'; end if;
 insert into public.table_members(table_id,user_id) values(t.id,uid)
 on conflict(table_id,user_id) do update set is_active=true,joined_at=now();
 if not private.is_table_member(t.id,t.host_id) then
  update public.tables set host_id=uid,updated_at=now() where id=t.id;
 end if;
 return t.id;
end $$;
create or replace function public.leave_table(p_table uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid:=private.current_user_id(); t public.tables%rowtype; next_host uuid;
begin
 select * into t from public.tables where id=p_table for update;
 if not found or not private.is_table_member(p_table,uid) then raise exception 'Not in table'; end if;
 if t.status <> 'lobby' then raise exception 'You can leave the roster after the current round'; end if;
 update public.table_members set is_active=false where table_id=p_table and user_id=uid;
 if t.host_id=uid then
  select user_id into next_host from public.table_members where table_id=p_table and is_active order by joined_at,user_id limit 1;
  if next_host is not null then update public.tables set host_id=next_host,updated_at=now() where id=p_table; end if;
 end if;
end $$;
create or replace function public.transfer_host(p_table uuid,p_new_host uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid:=private.current_user_id(); t public.tables%rowtype;
begin
 select * into t from public.tables where id=p_table for update;
 if not found or t.host_id<>uid then raise exception 'Only the current host can transfer ownership'; end if;
 if t.status<>'lobby' then raise exception 'Transfer the host between games'; end if;
 if not private.is_table_member(p_table,p_new_host) then raise exception 'New host must be an active participant'; end if;
 update public.tables set host_id=p_new_host,updated_at=now() where id=p_table;
end $$;
create or replace function public.start_round(p_table uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare uid uuid:=private.current_user_id(); t public.tables%rowtype; n int; min_n int; max_n int; rid uuid;
begin
 select * into t from public.tables where id=p_table for update;
 if not found or not private.is_table_member(p_table,uid) then raise exception 'Not in table'; end if;
 if t.status<>'lobby' then raise exception 'Finish current round first'; end if;
 min_n:=3; max_n:=case when t.mode in ('natural','single_double') then 8 else 16 end;
 select count(*) into n from public.table_members where table_id=p_table and is_active;
 if n<min_n or n>max_n then raise exception 'This mode requires 3 to % players',max_n; end if;
 insert into public.rounds(table_id,started_by) values(p_table,uid) returning id into rid;
 insert into public.round_players(round_id,user_id) select rid,user_id from public.table_members where table_id=p_table and is_active;
 insert into public.round_games(round_id,slot) values(rid,1);
 if t.mode in ('single_double','double_double') then insert into public.round_games(round_id,slot) values(rid,2); end if;
 update public.tables set status='playing',current_round_id=rid,updated_at=now() where id=p_table;
 return rid;
end $$;
create or replace function public.begin_results(p_table uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid:=private.current_user_id(); t public.tables%rowtype;
begin
 select * into t from public.tables where id=p_table for update;
 if not found or t.current_round_id is null or not private.is_round_player(t.current_round_id,uid) then raise exception 'Not a participant'; end if;
 if t.status<>'playing' then raise exception 'Round is not playing'; end if;
 update public.rounds set state='results' where id=t.current_round_id;
 update public.tables set status='results',updated_at=now() where id=p_table;
end $$;

-- Recalculate one mode transactionally, always taking participants' ratings as they
-- stood at the start of the physical round. Both parallel games share that snapshot.
-- Early version trades O(history) replay cost for deterministic correction semantics.
create or replace function private.rebuild_mode(p_mode public.durak_mode) returns void
language plpgsql security definer set search_path = '' as $$
declare
 r record; g record; loser uuid; w record; d record;
 n int; loser_rating double precision; gain double precision; mult double precision;
begin
 perform pg_advisory_xact_lock(hashtextextended('durak-rating-'||p_mode::text,0));
 delete from public.rating_ledger where mode=p_mode;
 update public.ratings set rating=1200,games=0,losses=0 where mode=p_mode;
 create temporary table if not exists durak_tmp_round_delta (user_id uuid primary key,delta double precision not null default 0) on commit drop;
 for r in
  select ro.id from public.rounds ro join public.tables t on t.id=ro.table_id
  where t.mode=p_mode and exists(select 1 from public.round_games x where x.round_id=ro.id and x.state in ('confirmed','tied'))
  order by ro.started_at,ro.id
 loop
  truncate table pg_temp.durak_tmp_round_delta;
  select count(*) into n from public.round_players where round_id=r.id;
  if n<3 then raise exception 'Invalid historical round with fewer than 3 players'; end if;
  for g in select * from public.round_games where round_id=r.id and state in ('confirmed','tied') order by slot loop
   if coalesce(array_length(g.loser_ids,1),0)<1 or coalesce(array_length(g.loser_ids,1),0)>=n then raise exception 'Invalid stored loser list'; end if;
   mult:=case when g.state='tied' then 0.5 else 1.0 end;
   foreach loser in array g.loser_ids loop
    select rating into loser_rating from public.ratings where user_id=loser and mode=p_mode;
    for w in
     select rp.user_id,rat.rating from public.round_players rp
     join public.ratings rat on rat.user_id=rp.user_id and rat.mode=p_mode
     where rp.round_id=r.id and not(rp.user_id=any(g.loser_ids))
    loop
     gain:=mult*32.0/(n-1)*(1.0-1.0/(1.0+power(10.0,(loser_rating-w.rating)/400.0)));
     insert into pg_temp.durak_tmp_round_delta(user_id,delta) values(w.user_id,gain)
     on conflict(user_id) do update set delta=durak_tmp_round_delta.delta+excluded.delta;
     insert into pg_temp.durak_tmp_round_delta(user_id,delta) values(loser,-gain)
     on conflict(user_id) do update set delta=durak_tmp_round_delta.delta+excluded.delta;
     insert into public.rating_ledger(game_id,user_id,mode,delta,recorded_at) values(g.id,w.user_id,p_mode,gain,g.finalized_at)
     on conflict(game_id,user_id) do update set delta=rating_ledger.delta+excluded.delta;
     insert into public.rating_ledger(game_id,user_id,mode,delta,recorded_at) values(g.id,loser,p_mode,-gain,g.finalized_at)
     on conflict(game_id,user_id) do update set delta=rating_ledger.delta+excluded.delta;
    end loop;
   end loop;
  end loop;
  update public.ratings rat set
   rating=rat.rating+coalesce((select td.delta from pg_temp.durak_tmp_round_delta td where td.user_id=rat.user_id),0),
   games=rat.games+(select count(*) from public.round_games gg where gg.round_id=r.id and gg.state in ('confirmed','tied')),
   losses=rat.losses+(select count(*) from public.round_games gg where gg.round_id=r.id and gg.state in ('confirmed','tied') and rat.user_id=any(gg.loser_ids))
  where rat.mode=p_mode and exists(select 1 from public.round_players rp where rp.round_id=r.id and rp.user_id=rat.user_id);
 end loop;
end $$;

create or replace function private.advance_round(p_game uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare g public.round_games%rowtype; t_id uuid; unfinished int;
begin
 select * into g from public.round_games where id=p_game;
 select table_id into t_id from public.rounds where id=g.round_id;
 select count(*) into unfinished from public.round_games where round_id=g.round_id and state not in ('confirmed','tied','unresolved','void');
 if unfinished=0 then
  update public.rounds set state='done',ended_at=now() where id=g.round_id;
  update public.tables set status='lobby',current_round_id=null,updated_at=now() where id=t_id;
 else
  update public.tables set updated_at=now() where id=t_id;
 end if;
end $$;
create or replace function private.finish_game(p_game uuid,p_losers uuid[],p_tied boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare g public.round_games%rowtype; m public.durak_mode; lid uuid;
begin
 select * into g from public.round_games where id=p_game for update;
 if g.state in ('confirmed','tied','unresolved','void') then raise exception 'Result already finalized'; end if;
 if array_length(p_losers,1) is null or (not p_tied and array_length(p_losers,1)<>1) then raise exception 'Invalid loser list'; end if;
 foreach lid in array p_losers loop
  if not private.is_round_player(g.round_id,lid) then raise exception 'Invalid loser'; end if;
 end loop;
 update public.round_games set state=case when p_tied then 'tied'::public.game_state else 'confirmed'::public.game_state end,
 loser_ids=p_losers,finalized_at=now(),deadline=null where id=p_game;
 select t.mode into m from public.rounds r join public.tables t on t.id=r.table_id where r.id=g.round_id;
 -- Self-admissions are stored in an auditable ledger; a baseline five-star
 -- display is not inflated beyond five. The events may inform reputation later.
 insert into public.honesty_events(game_id,user_id,kind)
 select p_game,v.voter_id,'self_admission' from public.game_votes v where v.game_id=p_game
 and v.voter_id=v.nominee_id and v.voter_id=any(p_losers)
 on conflict do nothing;
 perform private.rebuild_mode(m);
 perform private.advance_round(p_game);
end $$;
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
  update public.round_games set state='unresolved',finalized_at=now(),deadline=null where id=p_game;
  perform private.advance_round(p_game);return;
 end if;
 select array_agg(nominee_id order by nominee_id),count(*) into tied,top_count from public.vote_totals where game_id=p_game and votes=best;
 if top_count=1 then
  perform private.finish_game(p_game,array[leader],false);
 else
  update public.round_games set state='tie_offer',loser_ids=tied,allowed_nominees=tied,deadline=now()+interval '30 seconds' where id=p_game;
  delete from public.tie_responses where game_id=p_game;
 end if;
end $$;
create or replace function public.advance_expired(p_game uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare u uuid:=private.current_user_id(); rid uuid;
begin
 select round_id into rid from public.round_games where id=p_game;
 if rid is null or not private.is_round_player(rid,u) then raise exception 'Not a participant'; end if;
 perform private.expire_or_resolve(p_game);
end $$;
create or replace function public.cast_vote(p_game uuid,p_nominee uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare u uuid:=private.current_user_id(); g public.round_games%rowtype; prev_slot int;
begin
 select * into g from public.round_games where id=p_game for update;
 if not found or not private.is_round_player(g.round_id,u) then raise exception 'Not a participant'; end if;
 if not private.is_round_player(g.round_id,p_nominee) then raise exception 'Nominee was not playing'; end if;
 -- In parallel mode the second ballot cannot start until first resolves.
 select count(*) into prev_slot from public.round_games where round_id=g.round_id and slot<g.slot and state not in ('confirmed','tied','unresolved','void');
 if prev_slot>0 then raise exception 'Complete Game 1 voting first'; end if;
 if g.state='voting' and g.deadline<=now() then
  perform private.expire_or_resolve(p_game);
  return; -- State was advanced server-side; client will refresh.
 end if;
 if g.state not in ('awaiting','voting') then raise exception 'Voting is not open'; end if;
 if g.allowed_nominees is not null and not(p_nominee=any(g.allowed_nominees)) then raise exception 'Only tied candidates may receive votes in runoff'; end if;
 if g.state='awaiting' then
  update public.round_games set state='voting',deadline=now()+interval '30 seconds' where id=p_game;
 end if;
 insert into public.game_votes(game_id,voter_id,nominee_id) values(p_game,u,p_nominee)
 on conflict(game_id,voter_id) do update set nominee_id=excluded.nominee_id,updated_at=now();
 delete from public.vote_totals where game_id=p_game;
 insert into public.vote_totals(game_id,nominee_id,votes)
 select game_id,nominee_id,count(*)::integer from public.game_votes where game_id=p_game group by game_id,nominee_id;
 perform private.expire_or_resolve(p_game);
end $$;
create or replace function public.respond_to_tie(p_game uuid,p_accept boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare u uuid:=private.current_user_id(); g public.round_games%rowtype; response_count int; joined_count int;
begin
 select * into g from public.round_games where id=p_game for update;
 if not found or g.state<>'tie_offer' or g.deadline<=now() then raise exception 'Tie offer expired or inactive'; end if;
 if not (u=any(g.loser_ids)) then raise exception 'Only tied nominees can accept'; end if;
 insert into public.tie_responses(game_id,user_id,accept) values(p_game,u,p_accept)
 on conflict(game_id,user_id) do update set accept=excluded.accept,responded_at=now();
 if not p_accept then
  update public.round_games set state='voting',deadline=now()+interval '30 seconds',allowed_nominees=g.loser_ids,loser_ids='{}' where id=p_game;
  delete from public.game_votes where game_id=p_game;
  delete from public.vote_totals where game_id=p_game;
  return;
 end if;
 select count(*) into response_count from public.tie_responses where game_id=p_game and accept;
 joined_count:=coalesce(array_length(g.loser_ids,1),0);
 if response_count=joined_count then perform private.finish_game(p_game,g.loser_ids,true); end if;
end $$;
create or replace function public.restart_unresolved(p_game uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare u uuid:=private.current_user_id(); g public.round_games%rowtype; t public.tables%rowtype;
begin
 select * into g from public.round_games where id=p_game for update;
 if not found or not private.is_round_player(g.round_id,u) then raise exception 'Not a participant'; end if;
 if g.state<>'unresolved' then raise exception 'Only unresolved ballots can be restarted'; end if;
 select tb.* into t from public.rounds r join public.tables tb on tb.id=r.table_id where r.id=g.round_id for update of tb;
 if exists(select 1 from public.rounds rr where rr.table_id=t.id and rr.id<>g.round_id and rr.started_at>=(select started_at from public.rounds where id=g.round_id)) then
  raise exception 'A newer round has started; this result can no longer be restarted';
 end if;
 if t.status not in ('lobby','results') then raise exception 'Finish the active round first'; end if;
 if exists(select 1 from public.round_games x where x.round_id=g.round_id and x.id<>p_game and x.state in ('voting','tie_offer')) then
  raise exception 'Finish the active ballot before restarting another';
 end if;
 update public.round_games set state='awaiting',finalized_at=null,deadline=null,loser_ids='{}',allowed_nominees=null where id=p_game;
 update public.rounds set state='results',ended_at=null where id=g.round_id;
 delete from public.game_votes where game_id=p_game;
 delete from public.vote_totals where game_id=p_game;
 delete from public.tie_responses where game_id=p_game;
 update public.tables set status='results',current_round_id=g.round_id,updated_at=now() where id=t.id;
end $$;

create or replace function public.request_reversal(p_game uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare u uuid:=private.current_user_id(); g public.round_games%rowtype; cid uuid;
begin
 select * into g from public.round_games where id=p_game for update;
 if not found or not private.is_round_player(g.round_id,u) then raise exception 'Not a participant'; end if;
 if g.state not in ('confirmed','tied') or now()>g.finalized_at+interval '24 hours' then raise exception '24-hour correction window has passed'; end if;
 select id into cid from public.reversal_cases where game_id=p_game and state='open' limit 1;
 if cid is null then
  insert into public.reversal_cases(game_id,opened_by) values(p_game,u) returning id into cid;
 end if;
 return cid;
end $$;
create or replace function public.vote_reversal(p_case uuid,p_approve boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare u uuid:=private.current_user_id(); c public.reversal_cases%rowtype; g public.round_games%rowtype; n int; yes_count int; no_count int; m public.durak_mode;
begin
 select * into c from public.reversal_cases where id=p_case for update;
 if not found then raise exception 'Correction case missing'; end if;
 select * into g from public.round_games where id=c.game_id for update;
 if not private.is_round_player(g.round_id,u) then raise exception 'Not a participant'; end if;
 if c.state<>'open' then raise exception 'Case already closed'; end if;
 if now()>g.finalized_at+interval '24 hours' then
  update public.reversal_cases set state='expired' where id=c.id;
  return;
 end if;
 insert into public.reversal_votes(case_id,user_id,approve) values(c.id,u,p_approve)
 on conflict(case_id,user_id) do update set approve=excluded.approve;
 select count(*) into n from public.round_players where round_id=g.round_id;
 select count(*) filter(where approve),count(*) filter(where not approve) into yes_count,no_count from public.reversal_votes where case_id=c.id;
 if yes_count>n/2 then
  update public.reversal_cases set state='approved' where id=c.id;
  update public.round_games set state='void' where id=g.id;
  delete from public.honesty_events where game_id=g.id;
  select t.mode into m from public.rounds r join public.tables t on t.id=r.table_id where r.id=g.round_id;
  perform private.rebuild_mode(m);
 elsif no_count>n/2 then
  update public.reversal_cases set state='rejected' where id=c.id;
 end if;
end $$;

-- Explicit permissions: public functions are callable only by authenticated users.
revoke execute on all functions in schema public from public,anon;
revoke execute on all functions in schema private from public,anon,authenticated;
-- These narrowly scoped helpers are used by authenticated RLS read policies.
grant usage on schema private to authenticated;
grant execute on function private.is_table_member(uuid,uuid) to authenticated;
grant execute on function private.is_group_member(uuid,uuid) to authenticated;
grant execute on function private.is_round_player(uuid,uuid) to authenticated;
grant execute on function private.is_game_player(uuid,uuid) to authenticated;
grant usage on schema public to authenticated;
grant execute on function public.set_username(text) to authenticated;
grant execute on function public.create_friend_group(text) to authenticated;
grant execute on function public.join_friend_group(text) to authenticated;
grant execute on function public.create_table(public.durak_mode,uuid) to authenticated;
grant execute on function public.join_table(text) to authenticated;
grant execute on function public.leave_table(uuid) to authenticated;
grant execute on function public.transfer_host(uuid,uuid) to authenticated;
grant execute on function public.start_round(uuid) to authenticated;
grant execute on function public.begin_results(uuid) to authenticated;
grant execute on function public.cast_vote(uuid,uuid) to authenticated;
grant execute on function public.advance_expired(uuid) to authenticated;
grant execute on function public.respond_to_tie(uuid,boolean) to authenticated;
grant execute on function public.restart_unresolved(uuid) to authenticated;
grant execute on function public.request_reversal(uuid) to authenticated;
grant execute on function public.vote_reversal(uuid,boolean) to authenticated;
