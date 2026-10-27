-- Pre-game losing chance: remember each player's rating in the table's mode at the moment
-- the round starts. The lobby shows each player's estimated chance of being the Durak
-- (p_i = 10^(-R_i/400) / sum_j 10^(-R_j/400)); once the round is locked that estimate must
-- stay fixed, and in Single Double / Double Double a confirmed Game 1 already re-rates the
-- mode before Game 2 is voted on, so live ratings cannot provide it.
--
-- Additive only: one nullable column, filled by a trigger. start_round, the Elo replay,
-- scoring and every existing row are untouched (rounds started earlier keep NULL).
-- The value is display-only; no rating calculation reads it. It is readable through the
-- existing round_players policy (round participants only) and table-level select grant.
alter table public.round_players add column rating_at_start double precision;

create or replace function private.snapshot_round_rating() returns trigger
language plpgsql set search_path = '' as $$
begin
 select rat.rating into new.rating_at_start
 from public.rounds r
 join public.tables t on t.id=r.table_id
 join public.ratings rat on rat.user_id=new.user_id and rat.mode=t.mode
 where r.id=new.round_id;
 return new;
end $$;
create trigger round_players_rating_snapshot before insert on public.round_players
for each row execute function private.snapshot_round_rating();
revoke execute on function private.snapshot_round_rating() from public,anon,authenticated;
