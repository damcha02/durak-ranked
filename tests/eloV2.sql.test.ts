// Integration tests against the real migrations (supabase/migrations) running in PGlite.
import {describe,it,expect} from 'vitest'
import {createHash} from 'node:crypto'
import {Db,MODES,V2_MIGRATION,type Mode} from './sql/db'
import {rpcTable,rpcRound,expire} from './sql/flows'
import {ratingDeltas,ratingDeltasV1} from '../src/rating'

type Game={losers:string[];state?:'confirmed'|'tied'|'void'|'unresolved';id?:string}
type Round={mode:Mode;players:string[];games:Game[]}
const rated=(g:Game)=>{const s=g.state??(g.losers.length>1?'tied':'confirmed');return s==='confirmed'||s==='tied'}
/** Same rounding tie-break as the server: md5(game_id || user_id). */
const tieKey=(gameId:string)=>(id:string)=>createHash('md5').update(gameId+id).digest('hex')
const v2=(snapshot:{id:string;rating:number}[],g:Game)=>{
 if(!g.id)throw Error('game id needed to reproduce server rounding')
 return ratingDeltas(snapshot,g.losers,20,tieKey(g.id))
}
const cents=(x:number)=>Math.round(x*100)

/** TypeScript replay with the same semantics as the SQL: chronological rounds, start-of-round snapshot. */
function replayV2(history:Round[],mode:Mode,users:string[]){
 const s=Object.fromEntries(users.map(u=>[u,{cents:120000,games:0,losses:0}]))
 for(const r of history.filter(h=>h.mode===mode)){
  const snapshot=r.players.map(id=>({id,rating:s[id].cents/100})),round:Record<string,number>={}
  for(const g of r.games.filter(rated)){
   for(const [id,d] of Object.entries(v2(snapshot,g))){round[id]=(round[id]??0)+cents(d);s[id].games++}
   g.losers.forEach(id=>s[id].losses++)
  }
  for(const [id,c] of Object.entries(round))s[id].cents+=c
 }
 return s
}
const snapshotAfter=(history:Round[],mode:Mode,users:string[])=>{const s=replayV2(history,mode,users);return users.map(id=>({id,rating:s[id].cents/100}))}
function replayV1(history:Round[],mode:Mode,users:string[]){
 const s=Object.fromEntries(users.map(u=>[u,1200]))
 for(const r of history.filter(h=>h.mode===mode)){
  const snapshot=r.players.map(id=>({id,rating:s[id]})),round:Record<string,number>={}
  for(const g of r.games.filter(rated))for(const [id,d] of Object.entries(ratingDeltasV1(snapshot,g.losers)))round[id]=(round[id]??0)+d
  for(const [id,d] of Object.entries(round))s[id]+=d
 }
 return s
}
async function expectMatchesV2(db:Db,history:Round[],mode:Mode,users:string[]){
 const want=replayV2(history,mode,users),got=await db.ratings(mode)
 for(const u of users){
  expect(cents(got[u].rating),`${mode} rating of ${u}`).toBe(want[u].cents)
  expect(got[u].games).toBe(want[u].games);expect(got[u].losses).toBe(want[u].losses)
 }
}
/** Inserts rounds in order and records the generated game ids on the history. */
async function insertAll(db:Db,history:Round[]){
 for(const r of history){const {gameIds}=await db.insertRound(r.mode,r.players,r.games);r.games.forEach((g,i)=>g.id=gameIds[i])}
 return history
}
async function gameDeltas(db:Db,game:string){
 return Object.fromEntries((await db.ledger()).filter(l=>l.game_id===game).map(l=>[l.user_id,l.delta]))
}
function rng(seed:number){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}

async function gameState(db:Db,game:string){return (await db.one<{state:string;loser_ids:string[]}>(`select state,loser_ids from public.round_games where id=$1`,[game]))}

describe('feature switch and migration safety',()=>{
 it('applying the migration changes no rating, ledger or game record, and V1 stays live',async()=>{
  const db=await Db.create({withV2:false})
  const [a,b,c,d]=await db.users('alice','bob','carol','dave')
  await rpcRound(db,await rpcTable(db,'natural',[a,b,c]),[a,b,c],[a])
  await rpcRound(db,await rpcTable(db,'single_double',[a,b,c,d]),[a,b,c,d],[b,b])
  const games=await rpcRound(db,await rpcTable(db,'double_double',[a,b,c]),[a,b,c],[c,null])
  expect((await gameState(db,games[1])).state).toBe('unresolved')
  const before={rating:await db.ratingState(),records:await db.gameRecords()}
  expect(before.rating.ledger.length).toBeGreaterThan(0)

  await db.applyMigration(V2_MIGRATION)
  expect(await db.ratingState()).toEqual(before.rating)
  expect(await db.gameRecords()).toEqual(before.records)
  expect((await db.one<{formula:string;k:string}>(`select formula,k from private.rating_config`))).toEqual({formula:'v1',k:'20'})

  // Rebuilding through the dispatcher with the switch off reproduces V1 exactly.
  await db.rebuildAll()
  expect(await db.ratingState()).toEqual(before.rating)
  const [e,f,g]=await db.users('erin','frank','grace')
  const [game]=await rpcRound(db,await rpcTable(db,'natural',[e,f,g]),[e,f,g],[e])
  const deltas=await gameDeltas(db,game)
  expect(deltas[e]).toBeCloseTo(-16,10);expect(deltas[f]).toBeCloseTo(8,10)
 })

 it('keeps every new rating function and the switch away from browser roles',async()=>{
  const db=await Db.create()
  for(const fn of ['private.elo_v2_game_deltas(uuid[],numeric[],uuid[],numeric,text)','private.elo_v2_replay(public.durak_mode,numeric)',
   'private.rebuild_mode_v2(public.durak_mode)','private.rebuild_mode_v1(public.durak_mode)','private.rebuild_mode(public.durak_mode)','private.elo_v2_preview(public.durak_mode)'])
   for(const role of ['anon','authenticated'])
    expect((await db.one<{ok:boolean}>(`select has_function_privilege($1,$2,'execute') as ok`,[role,fn])).ok,`${role} ${fn}`).toBe(false)
  for(const role of ['anon','authenticated'])
   expect((await db.one<{ok:boolean}>(`select has_table_privilege($1,'private.rating_config','select,update') as ok`,[role])).ok).toBe(false)
 })
})

describe('V2 per-game SQL formula',()=>{
 const deltas=async(db:Db,players:string[],ratings:number[],losers:string[],tiebreak='')=>Object.fromEntries((await db.rows<{user_id:string;delta:string}>(
  `select user_id,delta from private.elo_v2_game_deltas($1::uuid[],$2::numeric[],$3::uuid[],20,$4)`,[players,ratings,losers,tiebreak])).map(r=>[r.user_id,Number(r.delta)]))

 it('charges a sole loser less at smaller tables (equal ratings)',async()=>{
  const db=await Db.create(),ids=await db.users(...Array.from({length:16},(_,i)=>`player${i}`))
  const losses=[]
  for(const n of [3,4,5,6,8,16])losses.push((await deltas(db,ids.slice(0,n),Array(n).fill(1200),[ids[0]]))[ids[0]])
  expect(losses.map(x=>Math.round(-x))).toEqual([13,15,16,17,18,19])
  for(let i=1;i<losses.length;i++)expect(losses[i]).toBeLessThan(losses[i-1])
 })

 it('matches the TypeScript reference to the cent and is exactly zero-sum (300 random games)',async()=>{
  const db=await Db.create(),ids=await db.users(...Array.from({length:16},(_,i)=>`player${i}`)),rand=rng(7)
  for(let t=0;t<300;t++){
   const n=3+Math.floor(rand()*14),players=ids.slice(0,n)
   // Every fourth game uses equal ratings so exact rounding ties are exercised too.
   const ratings=players.map(()=>t%4===0?1200:Math.round((900+rand()*700)*100)/100)
   const m=rand()<0.25?Math.min(Math.floor(n/2),2+Math.floor(rand()*3)):1,losers=[...players].sort(()=>rand()-0.5).slice(0,m)
   const sql=await deltas(db,players,ratings,losers,`game${t}`)
   const ts=ratingDeltas(players.map((id,i)=>({id,rating:ratings[i]})),losers,20,tieKey(`game${t}`))
   const sum=await db.one<{s:string}>(`select sum(delta)::text as s from private.elo_v2_game_deltas($1::uuid[],$2::numeric[],$3::uuid[],20,$4)`,[players,ratings,losers,`game${t}`])
   expect(Number(sum.s)).toBe(0)
   for(const id of players)expect(cents(sql[id]),`game ${t}`).toBe(cents(ts[id]))
  }
 })

 it('spreads rounding cents across players instead of always favouring the same ids',async()=>{
  const db=await Db.create(),ids=await db.users('alice','bob','carol'),loser=[...ids].sort().at(-1)!
  const seen=new Set<number>()
  for(let t=0;t<20;t++)seen.add((await deltas(db,ids,[1200,1200,1200],[loser],`game${t}`))[loser])
  expect([...seen].sort((x,y)=>x-y)).toEqual([-13.34,-13.33])
 })

 it('costs less to lose against stronger players and rejects invalid outcomes',async()=>{
  const db=await Db.create(),[a,b,c,d]=await db.users('alice','bob','carol','dave')
  const vsStrong=(await deltas(db,[a,b,c,d],[1200,1400,1300,1100],[a]))[a],vsWeak=(await deltas(db,[a,b,c,d],[1200,1000,1100,1100],[a]))[a]
  expect(vsStrong).toBeCloseTo(-14.53,1);expect(vsWeak).toBeCloseTo(-17.41,1)
  await expect(deltas(db,[a,b,c],[1200,1200,1200],[a,b,c])).rejects.toThrow(/Invalid loser list/)
  await expect(deltas(db,[a,b,c],[1200,1200,1200],[d])).rejects.toThrow(/Invalid loser list/)
  await expect(deltas(db,[a,b,a],[1200,1200,1200],[a])).rejects.toThrow(/Invalid participants/)
 })

 it('splits a mixed-rating shared loss in proportion to (1-p): stronger tied player pays more, nobody gains',async()=>{
  const db=await Db.create(),[a,b,c,d]=await db.users('alice','bob','carol','dave')
  const r=await deltas(db,[a,b,c,d],[1400,1000,1200,1200],[a,b])
  expect(r[a]).toBeCloseTo(-5.04,1);expect(r[b]).toBeCloseTo(-2.26,1);expect(r[c]).toBeCloseTo(3.65,1)
  const underdog=await deltas(db,[a,b,c,d],[1400,800,1400,1400],[a,b])
  expect(underdog[b]).toBeLessThanOrEqual(0)
 })
})

describe('V2 replay in the database',()=>{
 async function v2Db(names:string[]){const db=await Db.create();await db.setFormula('v2');return {db,ids:await db.users(...names)}}

 it('keeps the four modes isolated',async()=>{
  const {db,ids:[a,b,c,d,e]}=await v2Db(['alice','bob','carol','dave','erin'])
  const history=await insertAll(db,[
   {mode:'natural',players:[a,b,c],games:[{losers:[a]}]},
   {mode:'double_single',players:[a,b,c,d,e],games:[{losers:[b]}]},
   {mode:'single_double',players:[a,b,c,d],games:[{losers:[c]},{losers:[d]}]},
   {mode:'double_double',players:[a,b,c,d,e],games:[{losers:[e]},{losers:[a]}]},
   {mode:'natural',players:[a,b,c,d],games:[{losers:[d]}]},
  ])
  await db.rebuildAll()
  for(const m of MODES)await expectMatchesV2(db,history,m,[a,b,c,d,e])
  // Rebuilding one mode leaves the others untouched.
  const others=await db.rows(`select * from public.ratings where mode<>'natural' order by mode,user_id`)
  const otherLedger=await db.rows(`select * from public.rating_ledger where mode<>'natural' order by mode,game_id,user_id`)
  await db.rebuild('natural')
  expect(await db.rows(`select * from public.ratings where mode<>'natural' order by mode,user_id`)).toEqual(others)
  expect(await db.rows(`select * from public.rating_ledger where mode<>'natural' order by mode,game_id,user_id`)).toEqual(otherLedger)
 })

 it('rates both parallel games from the start-of-round snapshot, in both parallel modes',async()=>{
  const {db,ids}=await v2Db(['alice','bob','carol','dave']),[a,b,c]=ids
  for(const mode of ['single_double','double_double'] as Mode[]){
   const [warmup,sameLoser,split]=await insertAll(db,[{mode,players:ids,games:[{losers:[a]}]},
    {mode,players:ids,games:[{losers:[b]},{losers:[b]}]},{mode,players:ids,games:[{losers:[c]},{losers:[a]}]}])
   await db.rebuild(mode)
   await expectMatchesV2(db,[warmup,sameLoser,split],mode,ids)
   const expectGame=async(g:Game,snapshot:{id:string;rating:number}[])=>{
    const got=await gameDeltas(db,g.id!),want=v2(snapshot,g)
    ids.forEach(id=>expect(cents(got[id])).toBe(cents(want[id])))
   }
   // The same player losing both games is charged twice from the same ratings.
   const start=snapshotAfter([warmup],mode,ids)
   for(const g of sameLoser.games)await expectGame(g,start)
   // Game 2 uses the start-of-round ratings, not the ratings after game 1.
   const roundStart=snapshotAfter([warmup,sameLoser],mode,ids)
   for(const g of split.games)await expectGame(g,roundStart)
   const afterGame1=snapshotAfter([warmup,sameLoser,{...split,games:[split.games[0]]}],mode,ids)
   expect(Math.abs(v2(afterGame1,split.games[1])[a]-v2(roundStart,split.games[1])[a])).toBeGreaterThan(0.1)
  }
 })

 it('applies accepted shared losses through the real tie flow: reduced, zero-sum',async()=>{
  const {db,ids:[a,b,c,d]}=await v2Db(['alice','bob','carol','dave'])
  const tid=await rpcTable(db,'double_single',[a,b,c,d])
  const rid=await db.rpc<string>(a,'start_round',[tid]);await db.rpc(a,'begin_results',[tid])
  const {id:game}=await db.one<{id:string}>(`select id from public.round_games where round_id=$1`,[rid])
  await db.rpc(a,'cast_vote',[game,c]);await db.rpc(b,'cast_vote',[game,c]);await db.rpc(c,'cast_vote',[game,d]);await db.rpc(d,'cast_vote',[game,d])
  await expire(db,game);await db.rpc(a,'advance_expired',[game])
  expect((await gameState(db,game)).state).toBe('tie_offer')
  await db.rpc(c,'respond_to_tie',[game,true]);await db.rpc(d,'respond_to_tie',[game,true])
  expect(await gameState(db,game)).toEqual({state:'tied',loser_ids:[c,d].sort()})
  const ledger=await gameDeltas(db,game)
  for(const id of [c,d])expect(Math.abs(ledger[id]+5)).toBeLessThanOrEqual(0.01)
  for(const id of [a,b])expect(Math.abs(ledger[id]-5)).toBeLessThanOrEqual(0.01)
  expect(ledger[c]).toBeGreaterThan(-15) // a sole loss at this table costs -15
  expect(Object.values(ledger).reduce((s,x)=>s+cents(x),0)).toBe(0)
  const r=await db.ratings('double_single');expect(r[c].losses).toBe(1);expect(r[d].losses).toBe(1);expect(r[a].games).toBe(1)
 })

 it('replays history after an approved correction (void) and ignores a rejected one',async()=>{
  const {db,ids:[a,b,c]}=await v2Db(['alice','bob','carol'])
  const tid=await rpcTable(db,'natural',[a,b,c])
  const [g1]=await rpcRound(db,tid,[a,b,c],[a]),[g2]=await rpcRound(db,tid,[a,b,c],[b]),[g3]=await rpcRound(db,tid,[a,b,c],[a])
  const history=(voided:boolean):Round[]=>[{mode:'natural',players:[a,b,c],games:[{losers:[a],id:g1}]},
   {mode:'natural',players:[a,b,c],games:[{losers:[b],id:g2,state:voided?'void':'confirmed'}]},{mode:'natural',players:[a,b,c],games:[{losers:[a],id:g3}]}]
  await expectMatchesV2(db,history(false),'natural',[a,b,c])

  const rejected=await db.rpc<string>(c,'request_reversal',[g1])
  await db.rpc(a,'vote_reversal',[rejected,false]);await db.rpc(b,'vote_reversal',[rejected,false])
  expect((await db.one<{state:string}>(`select state from public.reversal_cases where id=$1`,[rejected])).state).toBe('rejected')
  await expectMatchesV2(db,history(false),'natural',[a,b,c])

  const records=await db.rows(`select id,round_id,slot,loser_ids from public.round_games order by id`)
  const approved=await db.rpc<string>(a,'request_reversal',[g2])
  await db.rpc(a,'vote_reversal',[approved,true]);await db.rpc(c,'vote_reversal',[approved,true])
  expect((await gameState(db,g2)).state).toBe('void')
  await expectMatchesV2(db,history(true),'natural',[a,b,c])
  expect((await db.ledger('natural')).filter(l=>l.game_id===g2)).toEqual([])
  expect((await db.ledger('natural')).filter(l=>l.game_id===g3).length).toBe(3)
  // The voided game itself is kept; only its state changed.
  expect(await db.rows(`select id,round_id,slot,loser_ids from public.round_games order by id`)).toEqual(records)
 })

 it('replays a reopened unresolved game at its original place in history',async()=>{
  const {db,ids:[a,b,c]}=await v2Db(['alice','bob','carol'])
  const tid=await rpcTable(db,'natural',[a,b,c])
  const [g1]=await rpcRound(db,tid,[a,b,c],[null])
  expect((await gameState(db,g1)).state).toBe('unresolved')
  const [g2]=await rpcRound(db,tid,[a,b,c],[a])
  await db.rpc(b,'restart_unresolved',[g1])
  await db.rpc(a,'cast_vote',[g1,c]);await db.rpc(b,'cast_vote',[g1,c])
  expect((await gameState(db,g1)).state).toBe('confirmed')
  await expectMatchesV2(db,[{mode:'natural',players:[a,b,c],games:[{losers:[c],id:g1}]},{mode:'natural',players:[a,b,c],games:[{losers:[a],id:g2}]}],'natural',[a,b,c])
 })

 it('is idempotent: replaying any number of times gives identical ratings and ledger',async()=>{
  const {db,ids}=await v2Db(['alice','bob','carol','dave','erin','frank'])
  const rand=rng(11)
  for(let i=0;i<40;i++){
   const mode=MODES[i%4],n=3+Math.floor(rand()*(ids.length-2)),players=ids.slice(0,n),parallel=mode==='single_double'||mode==='double_double'
   await db.insertRound(mode,players,(parallel?[0,1]:[0]).map(()=>({losers:[players[Math.floor(rand()*n)]]})))
  }
  await db.rebuildAll();const first=await db.ratingState()
  await db.rebuildAll();await db.rebuildAll()
  expect(await db.ratingState()).toEqual(first)
  // No duplicates: exactly one ledger row per participant per rated game.
  const {expected}=await db.one<{expected:number}>(`select count(*)::int as expected from public.round_games g join public.round_players rp on rp.round_id=g.round_id where g.state in ('confirmed','tied')`)
  expect(first.ledger.length).toBe(expected)
 })

 it('rounds deterministically: whole cents, every game sums to exactly zero, totals conserved',async()=>{
  const {db,ids}=await v2Db(Array.from({length:16},(_,i)=>`player${i}`))
  const rand=rng(3)
  for(let i=0;i<60;i++){
   const n=3+Math.floor(rand()*14),players=ids.slice(0,n),loser=players[Math.floor(rand()*n)],tie=rand()<0.2&&n>=4
   await db.insertRound('double_single',players,[{losers:tie?[loser,players.find(p=>p!==loser)!]:[loser]}])
  }
  await db.rebuild('double_single')
  expect(await db.rows(`select 1 from public.rating_ledger where delta::numeric<>round(delta::numeric,2)`)).toEqual([])
  expect(await db.rows(`select game_id from public.rating_ledger group by game_id having sum(delta::numeric)<>0`)).toEqual([])
  const {total,players}=await db.one<{total:string;players:number}>(`select sum(rating::numeric)::text as total,count(*)::int as players from public.ratings where mode='double_single'`)
  expect(Number(total)).toBe(1200*players)
 })

 it('matches the reference over many games with changing table sizes',async()=>{
  const {db,ids}=await v2Db(['ann','ben','cat','dan','eve'])
  const [A,B,C,D,E]=ids,history=await insertAll(db,[
   {mode:'natural',players:[A,B,C],games:[{losers:[A]}]},{mode:'natural',players:[A,B,C,D],games:[{losers:[B]}]},
   {mode:'natural',players:[A,B,C,D,E],games:[{losers:[C]}]},{mode:'natural',players:[A,B,C],games:[{losers:[C]}]},
   {mode:'natural',players:[A,B,C,D,E],games:[{losers:[A]}]}])
  await db.rebuild('natural')
  await expectMatchesV2(db,history,'natural',ids)
  // The worked example in docs/ELO_V2_DESIGN.md, to within a few cents of per-game rounding.
  const r=await db.ratings('natural'),doc=[1186.82,1206.28,1186.33,1212.67,1207.90]
  ids.forEach((id,i)=>expect(Math.abs(r[id].rating-doc[i])).toBeLessThanOrEqual(0.05))
  expect(Object.values(r).reduce((s,x)=>s+cents(x.rating),0)).toBe(1200*100*5)
 })

 it('rolls back completely when replay hits invalid history',async()=>{
  const {db,ids:[a,b,c,d]}=await v2Db(['alice','bob','carol','dave'])
  await db.insertRound('natural',[a,b,c],[{losers:[a]}]);await db.rebuild('natural')
  const before=await db.ratingState()
  await db.insertRound('natural',[a,b,c],[{losers:[d]}]) // loser who was not at the table
  await expect(db.rebuild('natural')).rejects.toThrow(/Invalid loser list/)
  expect(await db.ratingState()).toEqual(before)
 })
})

describe('activation dress rehearsal (what Phase C will do)',()=>{
 async function v1History(){
  const db=await Db.create(),[a,b,c,d,e]=await db.users('alice','bob','carol','dave','erin')
  const t1=await rpcTable(db,'natural',[a,b,c]),t2=await rpcTable(db,'single_double',[a,b,c,d]),t3=await rpcTable(db,'double_single',[a,b,c,d,e])
  const [n1]=await rpcRound(db,t1,[a,b,c],[a]),[s1,s2]=await rpcRound(db,t2,[a,b,c,d],[b,a]),[d1]=await rpcRound(db,t3,[a,b,c,d,e],[e])
  const [void1]=await rpcRound(db,t1,[a,b,c],[c]),[n3]=await rpcRound(db,t1,[a,b,c],[b])
  const cid=await db.rpc<string>(a,'request_reversal',[void1]);await db.rpc(a,'vote_reversal',[cid,true]);await db.rpc(b,'vote_reversal',[cid,true])
  const history:Round[]=[{mode:'natural',players:[a,b,c],games:[{losers:[a],id:n1}]},{mode:'single_double',players:[a,b,c,d],games:[{losers:[b],id:s1},{losers:[a],id:s2}]},
   {mode:'double_single',players:[a,b,c,d,e],games:[{losers:[e],id:d1}]},{mode:'natural',players:[a,b,c],games:[{losers:[c],state:'void',id:void1}]},
   {mode:'natural',players:[a,b,c],games:[{losers:[b],id:n3}]}]
  return {db,users:[a,b,c,d,e],history}
 }

 it('V1 history in the database matches the V1 reference',async()=>{
  const {db,users,history}=await v1History()
  for(const m of MODES){const want=replayV1(history,m,users),got=await db.ratings(m);users.forEach(u=>expect(got[u].rating).toBeCloseTo(want[u],9))}
 })

 it('preview is read-only and predicts exactly what activation produces',async()=>{
  const {db,users,history}=await v1History()
  const before={rating:await db.ratingState(),records:await db.gameRecords()}
  const preview=[];for(const m of MODES)preview.push(...await db.rows<{user_id:string;mode:Mode;v2_rating:string}>(`select * from private.elo_v2_preview($1)`,[m]))
  expect(await db.ratingState()).toEqual(before.rating)
  expect(await db.gameRecords()).toEqual(before.records)
  expect(preview.length).toBe(3+4+5) // players with games: natural, single_double, double_single
  await db.setFormula('v2');await db.rebuildAll()
  for(const p of preview)expect(cents(Number(p.v2_rating))).toBe(cents((await db.ratings(p.mode))[p.user_id].rating))
  for(const m of MODES)await expectMatchesV2(db,history,m,users)
 })

 it('activation keeps every game record and ledger shape, applies to new games, and is reversible',async()=>{
  const {db,users,history}=await v1History()
  const v1={rating:await db.ratingState(),records:await db.gameRecords()}
  await db.setFormula('v2');await db.rebuildAll()
  expect(await db.gameRecords()).toEqual(v1.records)
  const key=(l:{game_id:string;user_id:string;mode:Mode;recorded_at:Date})=>[l.game_id,l.user_id,l.mode,l.recorded_at]
  expect((await db.ledger()).map(key)).toEqual(v1.rating.ledger.map(key))
  for(const m of MODES)await expectMatchesV2(db,history,m,users)
  // New games after activation use V2: an equally rated 3-player sole loser gets -13.33 (±1 rounding cent).
  const [f,g,h]=await db.users('fay','gus','hal')
  const [game]=await rpcRound(db,await rpcTable(db,'natural',[f,g,h]),[f,g,h],[f])
  expect(Math.abs((await gameDeltas(db,game))[f]+13.33)).toBeLessThanOrEqual(0.01)
  // Switching back and replaying restores the original V1 ratings exactly.
  await db.setFormula('v1');await db.rebuildAll()
  const pick=(rows:Record<string,unknown>[])=>rows.filter(r=>users.includes(r.user_id as string)).map(r=>[r.user_id,r.mode,r.rating,r.games,r.losses])
  expect(pick((await db.ratingState()).ratings)).toEqual(pick(v1.rating.ratings))
 })
})
