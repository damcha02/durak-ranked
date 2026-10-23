-- DURAK RATINGS: run through Supabase CLI or SQL editor.
-- Business writes are performed via authenticated, validated RPCs, not table writes.
create schema if not exists private;
create type public.durak_mode as enum ('natural','double_single','single_double','double_double');
create type public.game_state as enum ('awaiting','voting','tie_offer','confirmed','tied','unresolved','void');

create table public.profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 username text unique not null check (username ~ '^[a-zA-Z0-9_]{3,22}$'),
 honesty_credit integer not null default 0,
 created_at timestamptz not null default now()
);
create table public.friend_groups (
 id uuid primary key default gen_random_uuid(),
 name text not null check(length(name) between 2 and 60),
 code text unique not null,
 owner_id uuid not null references public.profiles(id),
 created_at timestamptz not null default now()
);
create table public.group_members (
 group_id uuid not null references public.friend_groups(id) on delete cascade,
 user_id uuid not null references public.profiles(id) on delete cascade,
 joined_at timestamptz not null default now(),
 primary key(group_id,user_id)
);
create table public.tables (
 id uuid primary key default gen_random_uuid(),
 code text not null unique,
 mode public.durak_mode not null default 'natural',
 group_id uuid references public.friend_groups(id) on delete set null,
 host_id uuid not null references public.profiles(id),
 status text not null default 'lobby' check(status in ('lobby','playing','results')),
 current_round_id uuid,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table public.table_members (
 table_id uuid not null references public.tables(id) on delete cascade,
 user_id uuid not null references public.profiles(id) on delete cascade,
 is_active boolean not null default true,
 joined_at timestamptz not null default now(),
 primary key(table_id,user_id)
);
create table public.rounds (
 id uuid primary key default gen_random_uuid(),
 table_id uuid not null references public.tables(id) on delete cascade,
 started_by uuid not null references public.profiles(id),
 state text not null default 'playing' check(state in ('playing','results','done')),
 started_at timestamptz not null default now(),
 ended_at timestamptz
);
alter table public.tables add constraint tables_current_round_fk foreign key(current_round_id) references public.rounds(id) on delete set null;
create table public.round_players (
 round_id uuid not null references public.rounds(id) on delete cascade,
 user_id uuid not null references public.profiles(id),
 primary key(round_id,user_id)
);
create table public.round_games (
 id uuid primary key default gen_random_uuid(),
 round_id uuid not null references public.rounds(id) on delete cascade,
 slot integer not null check(slot in (1,2)),
 state public.game_state not null default 'awaiting',
 deadline timestamptz,
 loser_ids uuid[] not null default '{}',
 allowed_nominees uuid[],
 finalized_at timestamptz,
 unique(round_id,slot)
);
create table public.game_votes (
 game_id uuid not null references public.round_games(id) on delete cascade,
 voter_id uuid not null references public.profiles(id),
 nominee_id uuid not null references public.profiles(id),
 updated_at timestamptz not null default now(),
 primary key(game_id,voter_id)
);
create table public.vote_totals (
 game_id uuid not null references public.round_games(id) on delete cascade,
 nominee_id uuid not null references public.profiles(id),
 votes int not null default 0,
 primary key(game_id,nominee_id)
);
create table public.tie_responses (
 game_id uuid not null references public.round_games(id) on delete cascade,
 user_id uuid not null references public.profiles(id),
 accept boolean not null,
 responded_at timestamptz not null default now(),
 primary key(game_id,user_id)
);
create table public.ratings (
 user_id uuid not null references public.profiles(id) on delete cascade,
 mode public.durak_mode not null,
 rating double precision not null default 1200,
 games int not null default 0,
 losses int not null default 0,
 primary key(user_id,mode)
);
create table public.rating_ledger (
 game_id uuid not null references public.round_games(id) on delete cascade,
 user_id uuid not null references public.profiles(id) on delete cascade,
 mode public.durak_mode not null,
 delta double precision not null,
 recorded_at timestamptz not null,
 primary key(game_id,user_id)
);
create table public.honesty_events (
 game_id uuid not null references public.round_games(id) on delete cascade,
 user_id uuid not null references public.profiles(id),
 kind text not null check(kind='self_admission'),
 primary key(game_id,user_id)
);
create table public.reversal_cases (
 id uuid primary key default gen_random_uuid(),
 game_id uuid not null references public.round_games(id),
 opened_by uuid not null references public.profiles(id),
 created_at timestamptz not null default now(),
 state text not null default 'open' check(state in ('open','approved','rejected','expired'))
);
create unique index one_open_reversal_per_game on public.reversal_cases(game_id) where state='open';
create table public.reversal_votes (
 case_id uuid not null references public.reversal_cases(id) on delete cascade,
 user_id uuid not null references public.profiles(id),
 approve boolean not null,
 primary key(case_id,user_id)
);
create index rounds_by_table on public.rounds(table_id,started_at desc);
create index members_by_user on public.table_members(user_id,is_active);
create index group_members_by_user on public.group_members(user_id);
create index ledger_by_user_mode on public.rating_ledger(user_id,mode,recorded_at);
create index round_players_by_user on public.round_players(user_id);

-- Generate a unique public handle for each newly authenticated account.
create or replace function private.register_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 insert into public.profiles(id,username)
 values(new.id,'player_'||substr(replace(new.id::text,'-',''),1,16));
 insert into public.ratings(user_id,mode)
 select new.id,x.m from unnest(enum_range(null::public.durak_mode)) as x(m);
 return new;
end $$;
create trigger auth_user_created after insert on auth.users for each row execute function private.register_user();

create or replace function private.is_table_member(p_table uuid,p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.table_members where table_id=p_table and user_id=p_user and is_active);
$$;
create or replace function private.is_group_member(p_group uuid,p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.group_members where group_id=p_group and user_id=p_user);
$$;
create or replace function private.is_round_player(p_round uuid,p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.round_players where round_id=p_round and user_id=p_user);
$$;
create or replace function private.is_game_player(p_game uuid,p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.round_games g join public.round_players rp on rp.round_id=g.round_id
 where g.id=p_game and rp.user_id=p_user);
$$;

alter table public.profiles enable row level security;
alter table public.friend_groups enable row level security;
alter table public.group_members enable row level security;
alter table public.tables enable row level security;
alter table public.table_members enable row level security;
alter table public.rounds enable row level security;
alter table public.round_players enable row level security;
alter table public.round_games enable row level security;
alter table public.game_votes enable row level security;
alter table public.vote_totals enable row level security;
alter table public.tie_responses enable row level security;
alter table public.ratings enable row level security;
alter table public.rating_ledger enable row level security;
alter table public.honesty_events enable row level security;
alter table public.reversal_cases enable row level security;
alter table public.reversal_votes enable row level security;

create policy profiles_read on public.profiles for select to authenticated using (true);
-- No direct profile update: validate usernames in set_username RPC.
create policy rating_read on public.ratings for select to authenticated using (true);
create policy ledger_read on public.rating_ledger for select to authenticated using (true);
create policy group_read on public.friend_groups for select to authenticated using (private.is_group_member(id,(select auth.uid())));
create policy group_members_read on public.group_members for select to authenticated using (private.is_group_member(group_id,(select auth.uid())));
create policy table_read on public.tables for select to authenticated using (private.is_table_member(id,(select auth.uid())));
create policy member_read on public.table_members for select to authenticated using (private.is_table_member(table_id,(select auth.uid())));
create policy rounds_read on public.rounds for select to authenticated using (private.is_table_member(table_id,(select auth.uid())) or private.is_round_player(id,(select auth.uid())));
create policy round_players_read on public.round_players for select to authenticated using (private.is_round_player(round_id,(select auth.uid())));
create policy round_games_read on public.round_games for select to authenticated using (private.is_game_player(id,(select auth.uid())));
-- Individual votes become visible only once that individual game's result is final.
create policy votes_read_completed on public.game_votes for select to authenticated using (
 private.is_game_player(game_id,(select auth.uid())) and exists(
  select 1 from public.round_games where id=game_id and state in ('confirmed','tied','void','unresolved')));
create policy totals_read on public.vote_totals for select to authenticated using (private.is_game_player(game_id,(select auth.uid())));
create policy tie_responses_read on public.tie_responses for select to authenticated using (private.is_game_player(game_id,(select auth.uid())));
create policy honesty_read on public.honesty_events for select to authenticated using (true);
create policy reversal_read on public.reversal_cases for select to authenticated using (private.is_game_player(game_id,(select auth.uid())));
create policy reversal_votes_read on public.reversal_votes for select to authenticated using (
 exists(select 1 from public.reversal_cases c where c.id=case_id and private.is_game_player(c.game_id,(select auth.uid()))));

-- Browser clients may read but may NOT insert/update/delete game or rating tables.
revoke all on public.profiles,public.friend_groups,public.group_members,public.tables,public.table_members,
 public.rounds,public.round_players,public.round_games,public.game_votes,public.vote_totals,
 public.tie_responses,public.ratings,public.rating_ledger,public.honesty_events,public.reversal_cases,
 public.reversal_votes from anon;
grant usage on schema public to authenticated;
grant usage on type public.durak_mode,public.game_state to authenticated;
grant select on public.profiles,public.friend_groups,public.group_members,public.tables,public.table_members,
 public.rounds,public.round_players,public.round_games,public.game_votes,public.vote_totals,
 public.tie_responses,public.ratings,public.rating_ledger,public.honesty_events,public.reversal_cases,
 public.reversal_votes to authenticated;
-- Public RPC calls are defined explicitly in the second migration.
-- Realtime Postgres Changes: simple initial setup; can migrate to private Broadcast later.
do $$ begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') then
  alter publication supabase_realtime add table public.tables,public.table_members,public.rounds,public.round_games,public.vote_totals,public.tie_responses,public.reversal_cases,public.reversal_votes;
 end if;
end $$;
