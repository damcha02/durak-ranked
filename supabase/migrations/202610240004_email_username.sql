-- Stage 4.5: standard Supabase email/password accounts with chosen usernames.
-- Existing auth user IDs, game history, ratings and profile usernames remain unchanged.

-- Enforce case-insensitive uniqueness even when the profile is renamed later.
create unique index if not exists profiles_username_ci_unique
  on public.profiles (lower(username));

-- Supabase signUp({ options: { data: { username }}}) stores the chosen handle
-- in auth.users.raw_user_meta_data. The trigger validates it again.
-- OAuth signups without a handle keep a generated default username.
create or replace function private.register_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  requested text;
begin
  requested := nullif(trim(new.raw_user_meta_data ->> 'username'), '');
  if requested is not null and requested !~ '^[a-zA-Z0-9_]{3,22}$' then
    raise exception 'Invalid username format';
  end if;

  insert into public.profiles(id, username)
  values (
    new.id,
    coalesce(requested, 'player_' || substr(replace(new.id::text, '-', ''), 1, 15))
  );

  insert into public.ratings(user_id, mode)
  select new.id, m from unnest(enum_range(null::public.durak_mode)) as t(m);
  return new;
end $$;

-- The username -> auth user ID lookup is callable ONLY with the service-role key.
-- It never returns email addresses to the browser.
create or replace function public.lookup_username_for_login(p_username text)
returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare user_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Forbidden';
  end if;
  select id into user_id from public.profiles
    where lower(username)=lower(trim(p_username)) limit 1;
  return user_id;
end $$;
revoke all on function public.lookup_username_for_login(text) from public, anon, authenticated;
grant execute on function public.lookup_username_for_login(text) to service_role;

-- Atomic database-backed attempt limiting for the username sign-in bridge.
create table if not exists private.auth_rate_limits (
  key_hash text primary key,
  attempts integer not null,
  reset_at timestamptz not null
);
create or replace function public.username_signin_rate_limit(
  p_key_hash text, p_max_attempts integer, p_window_seconds integer
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  current_attempts integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Forbidden';
  end if;
  if length(p_key_hash) <> 64 or p_max_attempts not between 1 and 100
     or p_window_seconds not between 30 and 86400 then
    raise exception 'Invalid rate-limit configuration';
  end if;
  insert into private.auth_rate_limits(key_hash, attempts, reset_at)
  values (p_key_hash, 1, now() + make_interval(secs => p_window_seconds))
  on conflict (key_hash) do update set
    attempts = case
      when private.auth_rate_limits.reset_at <= now() then 1
      else private.auth_rate_limits.attempts + 1
    end,
    reset_at = case
      when private.auth_rate_limits.reset_at <= now()
        then now() + make_interval(secs => p_window_seconds)
      else private.auth_rate_limits.reset_at
    end
  returning attempts into current_attempts;
  return current_attempts <= p_max_attempts;
end $$;
revoke all on function public.username_signin_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.username_signin_rate_limit(text, integer, integer) to service_role;
