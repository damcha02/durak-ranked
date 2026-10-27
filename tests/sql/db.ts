// Loads the real Supabase migrations into an in-process PostgreSQL (PGlite) so the
// rating SQL can be tested without Docker or a hosted project.
import {PGlite} from '@electric-sql/pglite'
import {readdirSync,readFileSync} from 'node:fs'
import {join} from 'node:path'

export type Mode='natural'|'double_single'|'single_double'|'double_double'
export const MODES:Mode[]=['natural','double_single','single_double','double_double']
const MIGRATIONS=join(import.meta.dirname,'../../supabase/migrations')
export const V2_MIGRATION='202610260001_elo_v2.sql'
export const SNAPSHOT_MIGRATION='202610270001_round_rating_snapshot.sql'

// Minimal stand-ins for what Supabase provides: roles, auth.users, auth.uid(), auth.role().
const SUPABASE_STUB=`
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create table auth.users(id uuid primary key default gen_random_uuid(), raw_user_meta_data jsonb not null default '{}');
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),'authenticated') $$;
grant usage on schema auth to anon,authenticated,service_role;
`

export function migrationFiles(){return readdirSync(MIGRATIONS).filter(f=>f.endsWith('.sql')).sort()}

export class Db{
 private clock=Date.UTC(2026,9,1,18,0,0)
 private tableByMode=new Map<Mode,string>()
 readonly pg:PGlite
 constructor(pg:PGlite){this.pg=pg}
 /** `before` stops at that migration file (exclusive). */
 static async create({withV2=true,before}:{withV2?:boolean;before?:string}={}){
  const db=new Db(new PGlite())
  await db.pg.exec(SUPABASE_STUB)
  // withV2:false is the database as it was before Elo V2 (migrations 0001–0005), so later migrations are left out too.
  for(const f of migrationFiles())if((withV2||f<V2_MIGRATION)&&(!before||f<before))await db.applyMigration(f)
  return db
 }
 async applyMigration(file:string){await this.pg.exec(readFileSync(join(MIGRATIONS,file),'utf8'))}
 async rows<T=Record<string,unknown>>(sql:string,params:unknown[]=[]){return (await this.pg.query<T>(sql,params)).rows}
 async one<T=Record<string,unknown>>(sql:string,params:unknown[]=[]){return (await this.rows<T>(sql,params))[0]}
 async user(username:string){
  return (await this.one<{id:string}>(`insert into auth.users(raw_user_meta_data) values(jsonb_build_object('username',$1::text)) returning id`,[username])).id
 }
 async users(...names:string[]){const ids:string[]=[];for(const n of names)ids.push(await this.user(n));return ids}
 /** Calls a public RPC as the given signed-in user. */
 async rpc<T=unknown>(uid:string,fn:string,args:unknown[]=[]):Promise<T>{
  await this.pg.query(`select set_config('request.jwt.claim.sub',$1,false)`,[uid])
  const placeholders=args.map((_,i)=>`$${i+1}`).join(',')
  const r=await this.one<{v:T}>(`select public.${fn}(${placeholders}) as v`,args)
  return r.v
 }
 /**
  * Runs one of the psql scripts in scripts/elo-v2 as psql would, minus the meta-commands:
  * its own begin/commit/rollback lines are replaced by one transaction that commits only
  * when `commit` is true and the whole script succeeded.
  */
 async runPsqlScript(file:string,{commit}:{commit:boolean}){
  const body=readFileSync(join(import.meta.dirname,'../../scripts/elo-v2',file),'utf8').split('\n')
   .filter(l=>!l.startsWith('\\')&&!/^(begin|commit|rollback);$/.test(l.trim())).join('\n')
  await this.pg.exec('begin')
  try{await this.pg.exec(body)}catch(e){await this.pg.exec('rollback');throw e}
  await this.pg.exec(commit?'commit':'rollback')
 }
 async setFormula(formula:'v1'|'v2'){await this.pg.query(`update private.rating_config set formula=$1,updated_at=now()`,[formula])}
 async rebuild(mode:Mode){await this.pg.query(`select private.rebuild_mode($1::public.durak_mode)`,[mode])}
 async rebuildAll(){for(const m of MODES)await this.rebuild(m)}

 /** Inserts a finished historical round directly (as the database owner) without rebuilding. */
 async insertRound(mode:Mode,players:string[],games:{losers:string[];state?:'confirmed'|'tied'|'void'|'unresolved'}[],startedAt?:Date){
  let table=this.tableByMode.get(mode)
  if(!table){
   table=(await this.one<{id:string}>(`insert into public.tables(code,mode,host_id,status) values(upper(substr(md5(random()::text),1,8)),$1,$2,'lobby') returning id`,[mode,players[0]])).id
   this.tableByMode.set(mode,table)
  }
  const at=startedAt??new Date(this.clock+=60_000)
  const rid=(await this.one<{id:string}>(`insert into public.rounds(table_id,started_by,state,started_at,ended_at) values($1,$2,'done',$3,$3::timestamptz+interval '20 minutes') returning id`,[table,players[0],at.toISOString()])).id
  await this.pg.query(`insert into public.round_players(round_id,user_id) select $1,unnest($2::uuid[])`,[rid,players])
  const gameIds:string[]=[]
  for(const [i,g] of games.entries()){
   const state=g.state??(g.losers.length>1?'tied':'confirmed')
   gameIds.push((await this.one<{id:string}>(`insert into public.round_games(round_id,slot,state,loser_ids,finalized_at) values($1,$2,$3::public.game_state,$4::uuid[],$5::timestamptz+interval '25 minutes') returning id`,[rid,i+1,state,state==='unresolved'?[]:g.losers,at.toISOString()])).id)
  }
  return {roundId:rid,gameIds,startedAt:at}
 }

 async ratings(mode:Mode){
  const rs=await this.rows<{user_id:string;rating:number;games:number;losses:number}>(`select user_id,rating,games,losses from public.ratings where mode=$1 order by user_id`,[mode])
  return Object.fromEntries(rs.map(r=>[r.user_id,r]))
 }
 async ledger(mode?:Mode){
  return this.rows<{game_id:string;user_id:string;mode:Mode;delta:number;recorded_at:Date}>(
   `select game_id,user_id,mode,delta,recorded_at from public.rating_ledger ${mode?'where mode=$1':''} order by mode,game_id,user_id`,mode?[mode]:[])
 }
 /** Every table a rating change must never touch, as comparable JSON. */
 async gameRecords(){
  const out:Record<string,unknown>={}
  for(const t of ['profiles','friend_groups','group_members','tables','table_members','rounds','round_players','round_games','game_votes','vote_totals','tie_responses','honesty_events','reversal_cases','reversal_votes'])
   out[t]=(await this.rows(`select to_jsonb(x) as j from public.${t} x order by to_jsonb(x)::text`)).map(r=>r.j)
  out['auth.users']=(await this.rows(`select to_jsonb(x) as j from auth.users x order by id`)).map(r=>r.j)
  return out
 }
 async ratingState(){return {ratings:await this.rows(`select * from public.ratings order by mode,user_id`),ledger:await this.ledger()}}
}
