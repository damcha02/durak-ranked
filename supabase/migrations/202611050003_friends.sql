-- Friends replace friend groups in the app. A friendship is a request that the other person
-- accepts. A host can put an accepted friend straight onto a lobby table, without a code or QR.
-- Friend groups (tables and data) are left in place but nothing in the app uses them any more.

create table public.friendships (
 user_a uuid not null references public.profiles(id) on delete cascade,
 user_b uuid not null references public.profiles(id) on delete cascade,
 requested_by uuid not null references public.profiles(id) on delete cascade,
 status text not null default 'pending' check (status in ('pending','accepted')),
 created_at timestamptz not null default now(),
 primary key(user_a,user_b),
 check (user_a<user_b),
 check (requested_by in (user_a,user_b))
);
create index friendships_by_b on public.friendships(user_b);
alter table public.friendships enable row level security;
create policy friendships_read on public.friendships for select to authenticated
 using ((select auth.uid()) in (user_a,user_b));
revoke all on public.friendships from anon,authenticated;
grant select on public.friendships to authenticated;

create or replace function private.are_friends(p_a uuid,p_b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.friendships
  where user_a=least(p_a,p_b) and user_b=greatest(p_a,p_b) and status='accepted');
$$;

-- Asks a player (by username) to be friends. If they already asked you, it is accepted.
create or replace function public.send_friend_request(p_username text) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid:=private.current_user_id(); other uuid; f public.friendships%rowtype;
begin
 select id into other from public.profiles where lower(username)=lower(trim(p_username));
 if other is null then raise exception 'No player with that username'; end if;
 if other=uid then raise exception 'You cannot add yourself'; end if;
 select * into f from public.friendships where user_a=least(uid,other) and user_b=greatest(uid,other) for update;
 if not found then
  insert into public.friendships(user_a,user_b,requested_by) values(least(uid,other),greatest(uid,other),uid);
 elsif f.status='pending' and f.requested_by<>uid then
  update public.friendships set status='accepted' where user_a=f.user_a and user_b=f.user_b;
 end if;
end $$;

create or replace function public.respond_friend_request(p_user uuid,p_accept boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid:=private.current_user_id(); n int;
begin
 if p_accept then
  update public.friendships set status='accepted'
  where user_a=least(uid,p_user) and user_b=greatest(uid,p_user) and status='pending' and requested_by=p_user;
 else
  delete from public.friendships
  where user_a=least(uid,p_user) and user_b=greatest(uid,p_user) and status='pending' and requested_by=p_user;
 end if;
 get diagnostics n=row_count;
 if n=0 then raise exception 'No such friend request'; end if;
end $$;

-- Removes a friend, or cancels a request you sent.
create or replace function public.remove_friend(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid:=private.current_user_id();
begin
 delete from public.friendships where user_a=least(uid,p_user) and user_b=greatest(uid,p_user);
end $$;

-- The host seats an accepted friend at a lobby table.
create or replace function public.add_friend_to_table(p_table uuid,p_friend uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid:=private.current_user_id(); t public.tables%rowtype; n int; max_n int;
begin
 select * into t from public.tables where id=p_table for update;
 if not found or t.host_id<>uid then raise exception 'Only the host can add players'; end if;
 if t.closed_at is not null then raise exception 'Table is closed'; end if;
 if t.status<>'lobby' then raise exception 'Add players between games'; end if;
 if not private.are_friends(uid,p_friend) then raise exception 'You can only add friends'; end if;
 if private.is_table_member(p_table,p_friend) then return; end if;
 max_n:=case when t.mode in ('natural','single_double') then 8 else 16 end;
 select count(*) into n from public.table_members where table_id=p_table and is_active;
 if n>=max_n then raise exception 'Table is full'; end if;
 insert into public.table_members(table_id,user_id) values(p_table,p_friend)
 on conflict(table_id,user_id) do update set is_active=true,joined_at=now();
end $$;

revoke execute on function private.are_friends(uuid,uuid) from public,anon,authenticated;
revoke execute on function public.send_friend_request(text) from public,anon;
revoke execute on function public.respond_friend_request(uuid,boolean) from public,anon;
revoke execute on function public.remove_friend(uuid) from public,anon;
revoke execute on function public.add_friend_to_table(uuid,uuid) from public,anon;
grant execute on function public.send_friend_request(text) to authenticated;
grant execute on function public.respond_friend_request(uuid,boolean) to authenticated;
grant execute on function public.remove_friend(uuid) to authenticated;
grant execute on function public.add_friend_to_table(uuid,uuid) to authenticated;
