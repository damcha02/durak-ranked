-- Optional low-privilege health endpoint for an external scheduled availability check.
-- Monitoring database activity may reduce free-tier pausing, but does not guarantee uptime.
create table public.service_heartbeat (
 id integer primary key check(id=1),
 label text not null
);
insert into public.service_heartbeat(id,label) values(1,'durak-alive');
alter table public.service_heartbeat enable row level security;
create policy heartbeat_read on public.service_heartbeat for select to anon,authenticated using (true);
grant select on public.service_heartbeat to anon,authenticated;
