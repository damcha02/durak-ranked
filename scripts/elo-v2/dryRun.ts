// Elo V2 dry run, step 2: replays an export (export.sql) in a LOCAL in-process PostgreSQL
// loaded with this branch's migrations, and reports V1 vs V2 per player. It never connects
// to production; the only input is the export file.
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {Db,MODES,V2_MIGRATION,type Mode} from '../../tests/sql/db.ts'

type Rows=Record<string,unknown>[]
export type Export={meta:Record<string,unknown>;functions:{name:string;definition:string}[]}&Record<typeof DATA[number],Rows>
export type Check={name:string;ok:boolean;detail:string}
export type PlayerRow={user_id:string;username:string;mode:Mode;current_rating:number;v2_rating:number;difference:number;games:number;losses:number;current_rank:number;v2_rank:number}
export type ModeSummary={mode:Mode;players:number;rounds:number;rated:number;tied:number;voided:number;unresolved:number;
 correctionsApproved:number;correctionsRejected:number;correctionsOther:number;tableSizes:Record<string,number>}
export type Report={meta:Record<string,unknown>;checks:Check[];summaries:ModeSummary[];players:PlayerRow[]}

const DATA=['profiles','ratings','rating_ledger','tables','rounds','round_players','round_games','reversal_cases'] as const
const EXPORT_SQL=join(import.meta.dirname,'export.sql')

export function parseExport(text:string):Export{
 const out:Record<string,unknown>={}
 for(const line of text.split('\n').map(l=>l.trim()).filter(Boolean)){
  const o=JSON.parse(line) as {kind:string;rows?:unknown};out[o.kind]=o.kind==='meta'?o:o.rows
 }
 for(const k of ['meta','functions',...DATA])if(!(k in out))throw Error(`Export is missing "${k}"`)
 return out as Export
}
/** Runs export.sql against a local database (synthetic tests, and the drift reference). */
export async function exportFrom(db:Db){
 const results=await db.pg.exec(readFileSync(EXPORT_SQL,'utf8'))
 return results.filter(r=>r.rows.length===1&&r.fields.length===1).map(r=>JSON.stringify(Object.values(r.rows[0])[0])).join('\n')
}
async function load(ex:Export){
 // Production as it was when V2 was activated: the schema up to and including the V2 migration.
 const db=await Db.create({through:V2_MIGRATION})
 await db.pg.exec(`set session_replication_role=replica`) // historical rows as-is: no triggers, no FK re-checks
 await db.pg.query(`insert into auth.users(id) select (x->>'id')::uuid from jsonb_array_elements($1::jsonb) x`,[JSON.stringify(ex.profiles)])
 for(const t of DATA)await db.pg.query(`insert into public.${t} select * from jsonb_populate_recordset(null::public.${t},$1::jsonb)`,[JSON.stringify(ex[t])])
 await db.pg.exec(`set session_replication_role=origin`)
 return db
}
const norm=(s:string)=>s.replace(/\s+/g,' ').trim()
const list=(xs:unknown[],max=8)=>xs.length?xs.slice(0,max).join(', ')+(xs.length>max?` … (+${xs.length-max})`:''):'none'
const n=(x:unknown)=>Number(x)

export async function dryRun(ex:Export):Promise<Report>{
 const checks:Check[]=[],check=(name:string,ok:boolean,detail:string)=>checks.push({name,ok,detail})
 check('Export ran in a read-only transaction',ex.meta.read_only==='on',`read_only=${String(ex.meta.read_only)}, exported_at=${String(ex.meta.exported_at)}`)

 // 1. Deployed functions vs. this repository's already-applied migrations (everything before Elo V2).
 const reference=parseExport(await exportFrom(await Db.create({withV2:false}))).functions
 const prod=new Map(ex.functions.map(f=>[f.name,norm(f.definition)])),ref=new Map(reference.map(f=>[f.name,norm(f.definition)]))
 const differs=[...ref.keys()].filter(k=>prod.has(k)&&prod.get(k)!==ref.get(k)),missing=[...ref.keys()].filter(k=>!prod.has(k)),extra=[...prod.keys()].filter(k=>!ref.has(k))
 // The export must come from a database where the Elo V2 migration has NOT been applied yet.
 const v2Objects=[...prod.keys()].filter(k=>/^private\.(elo_v2_|rebuild_mode_v[12]\()/.test(k))
 check('Elo V2 is not installed in production',!v2Objects.length,v2Objects.length?`found: ${list(v2Objects)}`:'no elo_v2_* / rebuild_mode_v1 / rebuild_mode_v2 functions')
 check('Deployed functions match migrations 0001–0005',!differs.length&&!missing.length,
  `differ: ${list(differs)}; missing in production: ${list(missing)}; only in production: ${list(extra)}`)

 const db=await load(ex)
 // 2. History is valid input for a replay.
 const bad=await db.rows<{id:string;why:string}>(`
  with g as (select g.*,t.mode,(select array_agg(rp.user_id) from public.round_players rp where rp.round_id=g.round_id) as roster
   from public.round_games g join public.rounds r on r.id=g.round_id join public.tables t on t.id=r.table_id
   where g.state in ('confirmed','tied'))
  select id::text,case
   when roster is null or cardinality(roster)<3 then 'fewer than 3 players'
   when cardinality(loser_ids)<1 or cardinality(loser_ids)>=cardinality(roster) then 'loser count'
   when not loser_ids<@roster then 'loser not in roster'
   when state='confirmed' and cardinality(loser_ids)<>1 then 'confirmed with several losers'
   when state='tied' and cardinality(loser_ids)<2 then 'tie with one loser'
   when finalized_at is null then 'no finalized_at'
   when slot=2 and mode not in ('single_double','double_double') then 'second game in a single-game mode'
  end as why from g`)
 const invalid=bad.filter(b=>b.why)
 check('Every rated game is valid replay input',!invalid.length,invalid.length?invalid.map(b=>`${b.id}: ${b.why}`).join('; '):'all confirmed/tied games have 3+ players, 1 ≤ losers < players, losers in the locked roster')

 // 3. Stored ledger shape: one row per participant per rated game, nothing else, zero-sum.
 const shape=await db.one<{expected:number;actual:number;stray:number;wrong_mode:number;unbalanced:number}>(`
  select (select count(*)::int from public.round_games g join public.round_players rp on rp.round_id=g.round_id where g.state in ('confirmed','tied')) as expected,
   (select count(*)::int from public.rating_ledger) as actual,
   (select count(*)::int from public.rating_ledger l join public.round_games g on g.id=l.game_id where g.state not in ('confirmed','tied')) as stray,
   (select count(*)::int from public.rating_ledger l join public.round_games g on g.id=l.game_id join public.rounds r on r.id=g.round_id join public.tables t on t.id=r.table_id where t.mode<>l.mode) as wrong_mode,
   (select count(*)::int from (select game_id from public.rating_ledger group by game_id having abs(sum(delta))>1e-6) x) as unbalanced`)
 check('Stored ledger: one row per participant per rated game, zero-sum',shape.expected===shape.actual&&!shape.stray&&!shape.wrong_mode&&!shape.unbalanced,
  `expected ${shape.expected} rows, found ${shape.actual}; rows for unrated games: ${shape.stray}; wrong mode: ${shape.wrong_mode}; unbalanced games: ${shape.unbalanced}`)

 // 4. Stored ratings are exactly what a fresh V1 replay of the history produces (no drift, no manual edits).
 const stored=await db.ratingState()
 await db.pg.exec('begin')
 for(const m of MODES)await db.pg.query(`select private.rebuild_mode_v1($1)`,[m])
 const v1=await db.ratingState()
 await db.pg.exec('rollback')
 const byKey=(rows:Rows,k:(r:Record<string,unknown>)=>string)=>new Map(rows.map(r=>[k(r),r]))
 const v1r=byKey(v1.ratings,r=>`${r.mode}/${r.user_id}`)
 let maxRating=0;const countMismatch:string[]=[]
 for(const r of stored.ratings){const o=v1r.get(`${r.mode}/${r.user_id}`)!;maxRating=Math.max(maxRating,Math.abs(n(r.rating)-n(o.rating)));if(r.games!==o.games||r.losses!==o.losses)countMismatch.push(`${r.mode}/${r.user_id}`)}
 const v1l=byKey(v1.ledger,l=>`${l.game_id}/${l.user_id}`);let maxDelta=0,ledgerMismatch=v1.ledger.length!==stored.ledger.length
 for(const l of stored.ledger){const o=v1l.get(`${l.game_id}/${l.user_id}`);if(!o){ledgerMismatch=true;continue};maxDelta=Math.max(maxDelta,Math.abs(n(l.delta)-n(o.delta)))}
 check('Stored ratings equal a fresh V1 replay',maxRating<1e-6&&maxDelta<1e-6&&!countMismatch.length&&!ledgerMismatch,
  `max rating difference ${maxRating.toExponential(2)}, max ledger difference ${maxDelta.toExponential(2)}; games/losses mismatches: ${list(countMismatch)}; ledger keys differ: ${ledgerMismatch}`)

 // 5. The V2 dry run itself (read-only preview).
 const players:PlayerRow[]=[]
 for(const m of MODES)for(const r of await db.rows<Record<string,unknown>>(`select * from private.elo_v2_preview($1)`,[m]))
  players.push({user_id:String(r.user_id),username:String(r.username),mode:m,current_rating:n(r.current_rating),v2_rating:n(r.v2_rating),difference:n(r.difference),
   games:n(r.games),losses:n(r.losses),current_rank:n(r.current_rank),v2_rank:n(r.v2_rank)})
 const afterPreview=await db.ratingState()
 check('Preview wrote nothing',JSON.stringify(afterPreview)===JSON.stringify(stored),'ratings and ledger identical before and after the preview')

 // 6. Rehearse activation on the local copy and verify every invariant Phase C will assert.
 const records=await db.gameRecords()
 const ledgerKeys=(l:Rows)=>JSON.stringify(l.map(x=>[x.game_id,x.user_id,x.mode,x.recorded_at]))
 await db.setFormula('v2');await db.rebuildAll()
 const active=await db.ratingState()
 const sums=await db.one<{unbalanced:number;not_cents:number}>(`select
  (select count(*)::int from (select game_id from public.rating_ledger group by game_id having sum(delta::numeric)<>0) x) as unbalanced,
  (select count(*)::int from public.rating_ledger where delta::numeric<>round(delta::numeric,2)) as not_cents`)
 const totals=await db.rows<{mode:string;off:string}>(`select mode::text,(sum(rating::numeric)-1200*count(*))::text as off from public.ratings group by mode`)
 const activeMap=byKey(active.ratings,r=>`${r.mode}/${r.user_id}`)
 const previewMismatch=players.filter(p=>Math.round(n(activeMap.get(`${p.mode}/${p.user_id}`)!.rating)*100)!==Math.round(p.v2_rating*100))
 await db.rebuildAll();const again=await db.ratingState()
 check('Rehearsed activation keeps every game record',JSON.stringify(await db.gameRecords())===JSON.stringify(records),'profiles, tables, rounds, rosters, games, votes, ties, corrections unchanged')
 check('Rehearsed activation keeps the ledger shape',ledgerKeys(active.ledger)===ledgerKeys(stored.ledger),`${active.ledger.length} rows, same (game, user, mode, recorded_at) keys as today`)
 check('Rehearsed activation is exactly zero-sum in whole cents',!sums.unbalanced&&!sums.not_cents&&totals.every(t=>n(t.off)===0),
  `unbalanced games: ${sums.unbalanced}; non-cent deltas: ${sums.not_cents}; total offset per mode: ${totals.map(t=>`${t.mode} ${t.off}`).join(', ')}`)
 check('Preview equals the rehearsed activation',!previewMismatch.length,`mismatches: ${list(previewMismatch.map(p=>`${p.mode}/${p.username}`))}`)
 check('Replay is idempotent',JSON.stringify(again)===JSON.stringify(active),'a second full V2 replay is identical')
 await db.setFormula('v1');await db.rebuildAll()
 const back=await db.ratingState();let maxBack=0
 for(const r of back.ratings)maxBack=Math.max(maxBack,Math.abs(n(r.rating)-n(v1r.get(`${r.mode}/${r.user_id}`)!.rating)))
 check('Switching back to V1 restores current ratings',maxBack<1e-6,`max difference after V1 replay ${maxBack.toExponential(2)}`)

 // 7. Per-mode summary.
 const summaries:ModeSummary[]=[]
 for(const m of MODES){
  const s=await db.one<Record<string,number>>(`
   with g as (select g.* from public.round_games g join public.rounds r on r.id=g.round_id join public.tables t on t.id=r.table_id where t.mode=$1)
   select (select count(*)::int from public.ratings where mode=$1 and games>0) as players,
    (select count(distinct round_id)::int from g where state in ('confirmed','tied')) as rounds,
    (select count(*)::int from g where state in ('confirmed','tied')) as rated,(select count(*)::int from g where state='tied') as tied,
    (select count(*)::int from g where state='void') as voided,(select count(*)::int from g where state='unresolved') as unresolved,
    (select count(*)::int from public.reversal_cases c join g on g.id=c.game_id where c.state='approved') as approved,
    (select count(*)::int from public.reversal_cases c join g on g.id=c.game_id where c.state='rejected') as rejected,
    (select count(*)::int from public.reversal_cases c join g on g.id=c.game_id where c.state not in ('approved','rejected')) as other`,[m])
  const sizes=await db.rows<{size:number;games:number}>(`
   select (select count(*)::int from public.round_players rp where rp.round_id=g.round_id) as size,count(*)::int as games
   from public.round_games g join public.rounds r on r.id=g.round_id join public.tables t on t.id=r.table_id
   where t.mode=$1 and g.state in ('confirmed','tied') group by 1 order by 1`,[m])
  summaries.push({mode:m,players:s.players,rounds:s.rounds,rated:s.rated,tied:s.tied,voided:s.voided,unresolved:s.unresolved,
   correctionsApproved:s.approved,correctionsRejected:s.rejected,correctionsOther:s.other,tableSizes:Object.fromEntries(sizes.map(x=>[x.size,x.games]))})
 }
 return {meta:ex.meta,checks,summaries,players}
}

const MODE_NAME:Record<Mode,string>={natural:'Durak (natural)',double_single:'Double Single',single_double:'Single Double',double_double:'Double Double'}
const sign=(x:number)=>`${x>0?'+':x<0?'−':'±'}${Math.abs(x).toFixed(2)}`
export function renderMarkdown(r:Report){
 const out=[`# Elo V2 dry run (read-only)`,'',`Export taken ${String(r.meta.exported_at)} from PostgreSQL ${String(r.meta.server_version)}. Replayed locally; production was only read.`,'',
  `## Checks`,'','| | Check | Detail |','|---|---|---|',...r.checks.map(c=>`| ${c.ok?'PASS':'**FAIL**'} | ${c.name} | ${c.detail.replace(/\|/g,'/')} |`),'',
  `## History per mode`,'','| Mode | Players | Rounds | Rated games | Shared losses | Voided | Unresolved | Corrections approved / rejected / other | Rated games by table size |','|---|---|---|---|---|---|---|---|---|',
  ...r.summaries.map(s=>`| ${MODE_NAME[s.mode]} | ${s.players} | ${s.rounds} | ${s.rated} | ${s.tied} | ${s.voided} | ${s.unresolved} | ${s.correctionsApproved} / ${s.correctionsRejected} / ${s.correctionsOther} | ${Object.entries(s.tableSizes).map(([k,v])=>`${k}p: ${v}`).join(', ')||'–'} |`)]
 for(const m of MODES){
  const rows=r.players.filter(p=>p.mode===m)
  out.push('',`## ${MODE_NAME[m]}`,'')
  if(!rows.length){out.push('No rated games.');continue}
  out.push('| V2 rank | Was | Player | Current | V2 | Change | Games | Losses |','|---|---|---|---|---|---|---|---|',
   ...rows.map(p=>`| ${p.v2_rank} | ${p.current_rank}${p.v2_rank<p.current_rank?' ▲':p.v2_rank>p.current_rank?' ▼':''} | ${p.username} | ${p.current_rating.toFixed(2)} | ${p.v2_rating.toFixed(2)} | ${sign(p.difference)} | ${p.games} | ${p.losses} |`))
 }
 return out.join('\n')+'\n'
}
export function renderCsv(r:Report){
 const head='username,mode,current_rating,v2_rating,difference,games,losses,current_rank,v2_rank'
 return [head,...r.players.map(p=>[p.username,p.mode,p.current_rating,p.v2_rating.toFixed(2),p.difference.toFixed(2),p.games,p.losses,p.current_rank,p.v2_rank].join(','))].join('\n')+'\n'
}
