-- Elo V2 dry run, step 1: READ-ONLY export of everything the rating replay depends on.
-- Runs in one read-only, repeatable-read transaction (one consistent snapshot) that is
-- rolled back: PostgreSQL rejects any write inside it. Contains no e-mail addresses or
-- auth data, only profile ids and usernames. Table join codes are replaced.
--
-- Usage (psql prompts for the database password; nothing is stored):
--   mkdir -p scripts/elo-v2/out
--   psql "postgresql://postgres.<project-ref>@<pooler-host>:5432/postgres" \
--     -X -q -At -v ON_ERROR_STOP=1 -f scripts/elo-v2/export.sql -o scripts/elo-v2/out/export.jsonl
-- Each output line is one JSON object {"kind": ..., ...}.
begin transaction isolation level repeatable read read only;
select jsonb_build_object('kind','meta','exported_at',now(),'server_version',current_setting('server_version'),
 'read_only',current_setting('transaction_read_only'));
select jsonb_build_object('kind','functions','rows',coalesce(jsonb_agg(jsonb_build_object(
 'name',n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',
 'definition',pg_get_functiondef(p.oid)) order by n.nspname,p.proname),'[]'))
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname in ('public','private') and p.prokind='f';
select jsonb_build_object('kind','profiles','rows',coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'))
from (select id,username,honesty_credit,created_at from public.profiles) t;
select jsonb_build_object('kind','ratings','rows',coalesce(jsonb_agg(to_jsonb(t) order by t.mode,t.user_id),'[]'))
from public.ratings t;
select jsonb_build_object('kind','rating_ledger','rows',coalesce(jsonb_agg(to_jsonb(t) order by t.mode,t.game_id,t.user_id),'[]'))
from public.rating_ledger t;
select jsonb_build_object('kind','tables','rows',coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'))
from (select id,'X'||upper(left(md5(id::text),7)) as code,mode,null::uuid as group_id,host_id,status,
 current_round_id,created_at,updated_at from public.tables) t;
select jsonb_build_object('kind','rounds','rows',coalesce(jsonb_agg(to_jsonb(t) order by t.started_at,t.id),'[]'))
from public.rounds t;
select jsonb_build_object('kind','round_players','rows',coalesce(jsonb_agg(to_jsonb(t) order by t.round_id,t.user_id),'[]'))
from public.round_players t;
select jsonb_build_object('kind','round_games','rows',coalesce(jsonb_agg(to_jsonb(t) order by t.round_id,t.slot),'[]'))
from public.round_games t;
select jsonb_build_object('kind','reversal_cases','rows',coalesce(jsonb_agg(to_jsonb(t) order by t.created_at,t.id),'[]'))
from (select id,game_id,opened_by,created_at,state from public.reversal_cases) t;
rollback;
