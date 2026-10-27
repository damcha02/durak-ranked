// Pre-game losing chance: the formula (src/lossChance.ts, built on src/rating.ts), its agreement
// with the server's Elo V2 SQL, and the start-of-round snapshot (migration 202610270001).
import {describe,it,expect} from 'vitest'
import {randomUUID} from 'node:crypto'
import {formatChance,lossChances,readShowChances,saveShowChances} from '../src/lossChance'
import {Db,SNAPSHOT_MIGRATION,type Mode} from './sql/db'
import {rpcRound,rpcTable} from './sql/flows'

const SQL_TIMEOUT=60_000
const sum=(c:Record<string,{p:number}>)=>Object.values(c).reduce((s,x)=>s+x.p,0)
function rng(seed:number){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}

describe('losing chance',()=>{
 it('is equal for equal ratings',()=>{
  for(const n of [3,4,8,16]){
   const ids=Array.from({length:n},(_,i)=>`p${i}`),c=lossChances(ids,Object.fromEntries(ids.map(id=>[id,1200])))!
   for(const id of ids)expect(c[id].p).toBeCloseTo(1/n,12)
  }
 })
 it('totals 100% in full precision, and is only rounded for display',()=>{
  const r=rng(7)
  for(let i=0;i<200;i++){
   const ids=Array.from({length:3+Math.floor(r()*14)},(_,j)=>`p${j}`)
   const c=lossChances(ids,Object.fromEntries(ids.map(id=>[id,800+r()*900])))!
   expect(sum(c)).toBeCloseTo(1,12)
  }
  const thirds=lossChances(['a','b','c'],{a:1200,b:1200,c:1200})!
  expect(Object.values(thirds).map(x=>formatChance(x.p))).toEqual(['33.3%','33.3%','33.3%'])
  expect(thirds.a.p).not.toBe(0.333) // full precision is kept
  expect(formatChance(0.12345)).toBe('12.3%');expect(formatChance(0.0996)).toBe('10.0%')
 })
 it('is lower for higher-rated players',()=>{
  const c=lossChances(['a','b','c','d'],{a:1400,b:1300,c:1200,d:1000})!
  expect(c.a.p).toBeLessThan(c.b.p);expect(c.b.p).toBeLessThan(c.c.p);expect(c.c.p).toBeLessThan(c.d.p)
  expect(c.a.rating).toBe(1400)
 })
 it('follows the roster: joining and leaving renormalise everyone',()=>{
  const ratings={a:1300,b:1200,c:1100,d:1250}
  const three=lossChances(['a','b','c'],ratings)!,four=lossChances(['a','b','c','d'],ratings)!
  expect(Object.keys(four)).toEqual(['a','b','c','d'])
  for(const id of ['a','b','c'])expect(four[id].p).toBeLessThan(three[id].p)
  expect(lossChances(['a','b','c'],ratings)).toEqual(three) // d left again
  expect(sum(four)).toBeCloseTo(1,12)
 })
 it('shows nothing when a rating is missing or the table has fewer than 2 players',()=>{
  expect(lossChances(['a'],{a:1200})).toBeNull()
  expect(lossChances(['a','b','c'],{a:1200,b:1200})).toBeNull()
  expect(lossChances(['a','b','c'],{a:1200,b:1200,c:null})).toBeNull() // round started before the snapshot existed
 })
})

describe('show/hide preference',()=>{
 const memory=()=>{const m=new Map<string,string>();return{getItem:(k:string)=>m.get(k)??null,setItem:(k:string,v:string)=>void m.set(k,v)}}
 it('is on by default and remembers turning it off and on',()=>{
  const store=memory()
  expect(readShowChances(store)).toBe(true)
  saveShowChances(false,store);expect(readShowChances(store)).toBe(false)
  saveShowChances(true,store);expect(readShowChances(store)).toBe(true)
 })
 it('stays on when storage is missing or throws',()=>{
  const broken={getItem:()=>{throw Error('blocked')},setItem:()=>{throw Error('blocked')}}
  expect(readShowChances(undefined)).toBe(true);expect(readShowChances(broken)).toBe(true)
  expect(()=>saveShowChances(false,broken)).not.toThrow()
 })
})

describe('agreement with the server formula',()=>{
 it('equals the p inside private.elo_v2_game_deltas (winners gain K·p, the loser loses K·(1−p))',async()=>{
  const db=await Db.create(),K=1e6,r=rng(11) // a huge K turns the cent rounding into 1e-8 precision on p
  for(let t=0;t<12;t++){
   const ids=Array.from({length:3+Math.floor(r()*8)},()=>randomUUID()),ratings=ids.map(()=>Math.round((900+r()*700)*100)/100)
   const c=lossChances(ids,Object.fromEntries(ids.map((id,i)=>[id,ratings[i]])))!
   const loser=ids[t%ids.length]
   const rows=await db.rows<{user_id:string;delta:string}>(`select user_id,delta from private.elo_v2_game_deltas($1::uuid[],$2::numeric[],array[$3]::uuid[],$4)`,[ids,ratings,loser,K])
   for(const row of rows){
    const p=row.user_id===loser?1+Number(row.delta)/K:Number(row.delta)/K
    expect(Math.abs(p-c[row.user_id].p),`p of ${row.user_id}`).toBeLessThan(1e-7)
   }
  }
 },SQL_TIMEOUT)
})

// What the table screen reads: live ratings of the active members in the lobby, the stored snapshot once playing.
async function lobbyPreview(db:Db,tid:string){
 const {mode}=await db.one<{mode:Mode}>(`select mode from public.tables where id=$1`,[tid])
 const rows=await db.rows<{user_id:string;rating:number}>(`select m.user_id,r.rating from public.table_members m join public.ratings r on r.user_id=m.user_id and r.mode=$2 where m.table_id=$1 and m.is_active order by m.joined_at`,[tid,mode])
 return lossChances(rows.map(x=>x.user_id),Object.fromEntries(rows.map(x=>[x.user_id,x.rating])))
}
async function roundSnapshot(db:Db,rid:string){
 const rows=await db.rows<{user_id:string;rating:number|null}>(`select user_id,rating_at_start as rating from public.round_players where round_id=$1 order by user_id`,[rid])
 return lossChances(rows.map(x=>x.user_id),Object.fromEntries(rows.map(x=>[x.user_id,x.rating])))
}
const gamesOf=async(db:Db,rid:string)=>(await db.rows<{id:string}>(`select id from public.round_games where round_id=$1 order by slot`,[rid])).map(g=>g.id)
const vote=async(db:Db,game:string,voters:string[],loser:string)=>{for(const v of voters)await db.rpc(v,'cast_vote',[game,loser])}

describe('start-of-round snapshot',()=>{
 it('the lobby preview follows joins and leaves, and updates after a completed game',async()=>{
  const db=await Db.create();await db.setFormula('v2')
  const [a,b,c,d]=await db.users('alice','bob','carol','dave')
  const tid=await rpcTable(db,'natural',[a,b,c])
  const three=(await lobbyPreview(db,tid))!
  expect(Object.keys(three).sort()).toEqual([a,b,c].sort())
  for(const id of [a,b,c])expect(three[id].p).toBeCloseTo(1/3,12)
  const {code}=await db.one<{code:string}>(`select code from public.tables where id=$1`,[tid])
  await db.rpc(d,'join_table',[code])
  const four=(await lobbyPreview(db,tid))!
  expect(Object.keys(four).sort()).toEqual([a,b,c,d].sort());expect(four[a].p).toBeCloseTo(1/4,12)
  await db.rpc(d,'leave_table',[tid])
  expect(await lobbyPreview(db,tid)).toEqual(three)

  await rpcRound(db,tid,[a,b,c],[a]) // alice loses, the table is back in the lobby
  const after=(await lobbyPreview(db,tid))!,rating=await db.ratings('natural')
  expect(after[a].rating).toBe(rating[a].rating);expect(after[a].rating).toBeLessThan(1200)
  expect(after[a].p).toBeGreaterThan(after[b].p) // alice now has the highest estimated chance of losing
  expect(sum(after)).toBeCloseTo(1,12)
 },SQL_TIMEOUT)

 it('stays fixed for both games of a parallel round and uses that mode\'s ratings',async()=>{
  const db=await Db.create();await db.setFormula('v2')
  const [a,b,c,d]=await db.users('alice','bob','carol','dave')
  // Different histories per mode, so a mix-up between modes would show.
  const natural=await rpcTable(db,'natural',[a,b,c,d])
  await rpcRound(db,natural,[a,b,c,d],[a]);await rpcRound(db,natural,[a,b,c,d],[a])
  const sd=await rpcTable(db,'single_double',[a,b,c,d])
  await rpcRound(db,sd,[a,b,c,d],[d,c])
  const before=await db.ratings('single_double'),naturalRatings=await db.ratings('natural')
  const preview=(await lobbyPreview(db,sd))!

  const rid=await db.rpc<string>(a,'start_round',[sd])
  const snap=(await roundSnapshot(db,rid))!
  for(const id of [a,b,c,d]){expect(snap[id].rating).toBe(before[id].rating);expect(snap[id].rating).not.toBe(naturalRatings[id].rating)}
  expect(snap).toEqual(preview) // the locked roster gets exactly what the lobby showed

  await db.rpc(a,'begin_results',[sd])
  const [g1,g2]=await gamesOf(db,rid)
  await vote(db,g1,[a,b,c],b)
  expect((await db.ratings('single_double'))[b].rating).toBeLessThan(before[b].rating) // Game 1 already re-rated the mode…
  expect(await roundSnapshot(db,rid)).toEqual(snap) // …but Game 2 keeps the start-of-round estimate
  await vote(db,g2,[a,b,c],a)
  expect(await roundSnapshot(db,rid)).toEqual(snap)

  // The next round starts from the updated ratings.
  const now=await db.ratings('single_double'),next=await db.rpc<string>(a,'start_round',[sd])
  const nextSnap=(await roundSnapshot(db,next))!
  for(const id of [a,b,c,d])expect(nextSnap[id].rating).toBe(now[id].rating)
  expect(nextSnap[b].p).not.toBeCloseTo(snap[b].p,6)
 },SQL_TIMEOUT)

 it('is readable only by the round\'s players',async()=>{
  const db=await Db.create()
  const [a,b,c,eve]=await db.users('alice','bob','carol','eve')
  const tid=await rpcTable(db,'natural',[a,b,c])
  const rid=await db.rpc<string>(a,'start_round',[tid])
  const as=async(uid:string)=>{
   await db.pg.exec('begin');await db.pg.query(`select set_config('request.jwt.claim.sub',$1,true)`,[uid]);await db.pg.exec('set local role authenticated')
   try{return await db.rows<{rating_at_start:number}>(`select rating_at_start from public.round_players where round_id=$1`,[rid])}finally{await db.pg.exec('rollback')}
  }
  expect((await as(b)).map(r=>r.rating_at_start)).toEqual([1200,1200,1200])
  expect(await as(eve)).toEqual([])
 },SQL_TIMEOUT)

 it('applying the migration changes no rating, ledger or existing game record',async()=>{
  const db=await Db.create({before:SNAPSHOT_MIGRATION});await db.setFormula('v2')
  const [a,b,c,d]=await db.users('alice','bob','carol','dave')
  await rpcRound(db,await rpcTable(db,'natural',[a,b,c]),[a,b,c],[a])
  await rpcRound(db,await rpcTable(db,'double_double',[a,b,c,d]),[a,b,c,d],[b,null])
  const ratings=await db.ratingState(),records=await db.gameRecords()
  await db.applyMigration(SNAPSHOT_MIGRATION)
  expect(await db.ratingState()).toEqual(ratings)
  const after=await db.gameRecords(),players=after.round_players as Record<string,unknown>[]
  expect(players.every(p=>p.rating_at_start===null)).toBe(true) // old rounds: no estimate, nothing back-filled
  expect({...after,round_players:players.map(({rating_at_start:_,...rest})=>rest)}).toEqual({...records,round_players:(records.round_players as Record<string,unknown>[])})
  await db.rebuildAll();expect(await db.ratingState()).toEqual(ratings)
 },SQL_TIMEOUT)
})
