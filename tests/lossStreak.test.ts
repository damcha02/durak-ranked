// Losing-streak penalty (migration 202610290001, rule loss_streak_v1) against the real migrations in PGlite,
// cross-checked with the TypeScript reference in src/rating.ts.
import {describe,it,expect} from 'vitest'
import {createHash} from 'node:crypto'
import {Db,MODES,V2_MIGRATION,STREAK_MIGRATION,migrationFiles,type Mode} from './sql/db'
import {rpcTable,rpcRound,rpcTiedRound,rpcCorrection,productionLike} from './sql/flows'
import {ratingDeltas,streakDeltas} from '../src/rating'

const T=120_000
const cents=(x:number|string)=>Math.round(Number(x)*100)
const tieKey=(gameId:string)=>(id:string)=>createHash('md5').update(gameId+id).digest('hex')
const sumCents=(r:Record<string,number>)=>Object.values(r).reduce((s,x)=>s+cents(x),0)

async function activate(db:Db,from?:Date){
 await db.pg.query(`update private.rating_config set streak_rule='loss_streak_v1',streak_from=coalesce($1::timestamptz,now()),updated_at=now()`,[from?.toISOString()??null])
}
/** V2 with the streak rule active from now: every round played through the RPCs is covered. */
async function streakDb(){const db=await Db.create();await db.setFormula('v2');await activate(db);return db}

type Entry={delta:number;streak_extra:number;loss_streak:number|null}
async function ledgerOf(db:Db,game:string){
 return Object.fromEntries((await db.rows<Entry&{user_id:string}>(`select user_id,delta,streak_extra,loss_streak from public.rating_ledger where game_id=$1`,[game])).map(r=>[r.user_id,r]))
}
const deltasOf=(l:Record<string,Entry>)=>Object.fromEntries(Object.entries(l).map(([u,e])=>[u,e.delta]))
/**
 * Everyone's rating at the start of the game's round as the replay sees it (the snapshot both parallel
 * games are rated from): 1200 plus the ledger of every earlier round in the mode. After a correction or a
 * reopened vote this differs from round_players.rating_at_start, which was taken when the round began.
 */
async function snapshotOf(db:Db,game:string){
 return (await db.rows<{id:string;rating:string}>(`select rp.user_id as id,(1200+coalesce((select sum(l.delta::numeric) from public.rating_ledger l
   join public.round_games x on x.id=l.game_id join public.rounds ro on ro.id=x.round_id join public.tables tt on tt.id=ro.table_id
   where l.user_id=rp.user_id and tt.mode=t.mode and (ro.started_at,ro.id)<(r.started_at,r.id)),0))::text as rating
  from public.round_games g join public.rounds r on r.id=g.round_id join public.tables t on t.id=r.table_id
  join public.round_players rp on rp.round_id=r.id where g.id=$1 order by rp.user_id`,[game])).map(x=>({id:x.id,rating:Number(x.rating)}))
}
async function lossOf(db:Db,game:string){return (await db.one<{loser_ids:string[]}>(`select loser_ids from public.round_games where id=$1`,[game])).loser_ids}
/** The plain V2 result of a game, from its round's snapshot. */
async function plainV2(db:Db,game:string){return ratingDeltas(await snapshotOf(db,game),await lossOf(db,game),20,tieKey(game))}
async function streaks(db:Db,mode:Mode){
 return Object.fromEntries((await db.rows<{user_id:string;loss_streak:number}>(`select user_id,loss_streak from public.ratings where mode=$1`,[mode])).map(r=>[r.user_id,r.loss_streak]))
}
/** A sole loss with the penalty: matches the reference, 1.25x to the cent, extra shared by the winners. */
async function expectPenalized(db:Db,game:string,loser:string,streak:number){
 const l=await ledgerOf(db,game),plain=await plainV2(db,game),ref=streakDeltas(await snapshotOf(db,game),[loser],[loser],20,tieKey(game))
 for(const [u,e] of Object.entries(l)){
  expect(cents(e.delta),`delta of ${u}`).toBe(cents(ref.delta[u]))
  expect(cents(e.streak_extra),`extra of ${u}`).toBe(cents(ref.extra[u]))
  expect(cents(e.delta)-cents(e.streak_extra)).toBe(cents(plain[u])) // normal V2 + penalty share
  if(u!==loser)expect(e.streak_extra).toBeGreaterThanOrEqual(0)
 }
 expect(Math.abs(cents(l[loser].delta)-1.25*cents(plain[loser]))).toBeLessThanOrEqual(1)
 expect(l[loser].streak_extra).toBeLessThan(0)
 expect(l[loser].loss_streak).toBe(streak)
 expect(sumCents(deltasOf(l))).toBe(0)
 expect(Object.values(l).reduce((s,e)=>s+cents(e.streak_extra),0)).toBe(0)
}
async function expectNormal(db:Db,game:string,streakOf?:Record<string,number|null>){
 const l=await ledgerOf(db,game),plain=await plainV2(db,game)
 for(const [u,e] of Object.entries(l)){
  expect(cents(e.delta),`delta of ${u}`).toBe(cents(plain[u]));expect(e.streak_extra).toBe(0)
  if(streakOf&&u in streakOf)expect(e.loss_streak,`streak of ${u}`).toBe(streakOf[u])
 }
 expect(sumCents(deltasOf(l))).toBe(0)
}
async function penalizedGames(db:Db){return (await db.rows<{game_id:string}>(`select distinct game_id from public.rating_ledger where streak_extra<0`)).map(r=>r.game_id).sort()}

describe('streak rule',()=>{
 it('charges plain V2 for the 1st to 3rd loss and 25% more from the 4th on',async()=>{
  const db=await streakDb(),[a,b,c]=await db.users('alice','bob','carol'),players=[a,b,c]
  const tid=await rpcTable(db,'natural',players)
  for(let i=1;i<=6;i++){
   const [g]=await rpcRound(db,tid,players,[a])
   if(i<=3)await expectNormal(db,g,{[a]:i,[b]:0,[c]:0});else await expectPenalized(db,g,a,i)
   expect((await streaks(db,'natural'))[a]).toBe(i)
  }
 },T)

 it('resets the count on a win',async()=>{
  const db=await streakDb(),[a,b,c]=await db.users('alice','bob','carol'),players=[a,b,c]
  const tid=await rpcTable(db,'natural',players)
  for(let i=0;i<4;i++)await rpcRound(db,tid,players,[a])
  await rpcRound(db,tid,players,[b])
  expect(await streaks(db,'natural')).toEqual({[a]:0,[b]:1,[c]:0})
  const [g]=await rpcRound(db,tid,players,[a])
  await expectNormal(db,g,{[a]:1,[b]:0})
 },T)

 it('keeps the modes independent',async()=>{
  const db=await streakDb(),[a,b,c]=await db.users('alice','bob','carol'),players=[a,b,c]
  const natural=await rpcTable(db,'natural',players),big=await rpcTable(db,'double_single',players)
  for(let i=0;i<3;i++)await rpcRound(db,natural,players,[a])
  const [other]=await rpcRound(db,big,players,[a])
  await expectNormal(db,other,{[a]:1}) // first loss in Double Single
  // A Double Single result does not touch the Durak count, win or loss.
  await rpcRound(db,big,players,[b])
  const [fourth]=await rpcRound(db,natural,players,[a])
  await expectPenalized(db,fourth,a,4)
  expect((await streaks(db,'natural'))[a]).toBe(4);expect((await streaks(db,'double_single'))[a]).toBe(0)
 },T)

 it('carries the count across tables of the same mode',async()=>{
  const db=await streakDb(),[a,b,c,d,e]=await db.users('alice','bob','carol','dave','erin')
  const t1=await rpcTable(db,'natural',[a,b,c]),t2=await rpcTable(db,'natural',[a,d,e])
  await rpcRound(db,t1,[a,b,c],[a]);await rpcRound(db,t2,[a,d,e],[a]);await rpcRound(db,t1,[a,b,c],[a])
  const [g]=await rpcRound(db,t2,[a,d,e],[a])
  await expectPenalized(db,g,a,4)
  // Winning at one table resets it for every table.
  await rpcRound(db,t1,[a,b,c],[b])
  const [h]=await rpcRound(db,t2,[a,d,e],[a])
  await expectNormal(db,h,{[a]:1})
 },T)

 it('ignores unresolved games',async()=>{
  const db=await streakDb(),[a,b,c]=await db.users('alice','bob','carol'),players=[a,b,c]
  const tid=await rpcTable(db,'natural',players)
  for(let i=0;i<3;i++)await rpcRound(db,tid,players,[a])
  const [open]=await rpcRound(db,tid,players,[null])
  expect(await ledgerOf(db,open)).toEqual({})
  const [g]=await rpcRound(db,tid,players,[a])
  await expectPenalized(db,g,a,4)
 },T)
})

describe('shared losses',()=>{
 it('charges extra only to the tied player on a streak, and gives it to the winners',async()=>{
  const db=await streakDb(),players=await db.users('alice','bob','carol','dave','erin','frank'),[a,b,c,d,e,f]=players
  const tid=await rpcTable(db,'double_single',players)
  for(let i=0;i<3;i++)await rpcRound(db,tid,players,[d])
  const game=await rpcTiedRound(db,tid,players,[d,e])
  const l=await ledgerOf(db,game),snapshot=await snapshotOf(db,game),plain=ratingDeltas(snapshot,[d,e],20,tieKey(game))
  const ref=streakDeltas(snapshot,[d,e],[d],20,tieKey(game))
  for(const u of players){expect(cents(l[u].delta),u).toBe(cents(ref.delta[u]));expect(cents(l[u].streak_extra),u).toBe(cents(ref.extra[u]))}
  expect(cents(l[e].delta)).toBe(cents(plain[e]));expect(l[e].streak_extra).toBe(0) // not on a streak: normal share
  expect(Math.abs(cents(l[d].delta)-1.25*cents(plain[d]))).toBeLessThanOrEqual(1)
  for(const w of [a,b,c,f]){expect(l[w].delta).toBeGreaterThanOrEqual(plain[w]);expect(l[w].loss_streak).toBe(0)}
  expect([a,b,c,f].reduce((s,w)=>s+cents(l[w].streak_extra),0)).toBe(-cents(l[d].streak_extra))
  expect(sumCents(deltasOf(l))).toBe(0)
  expect([l[d].loss_streak,l[e].loss_streak]).toEqual([4,1]) // a shared loss counts as a loss for both
 },T)

 it('charges every tied player who is on a streak',async()=>{
  const db=await streakDb(),players=await db.users('alice','bob','carol','dave','erin','frank'),[,,,d,e]=players
  const tid=await rpcTable(db,'double_single',players)
  for(let i=0;i<3;i++){const g=await rpcTiedRound(db,tid,players,[d,e]);await expectNormal(db,g,{[d]:i+1,[e]:i+1})}
  const game=await rpcTiedRound(db,tid,players,[d,e])
  const l=await ledgerOf(db,game),ref=streakDeltas(await snapshotOf(db,game),[d,e],[d,e],20,tieKey(game))
  for(const u of players)expect(cents(l[u].delta),u).toBe(cents(ref.delta[u]))
  expect(l[d].streak_extra).toBeLessThan(0);expect(l[e].streak_extra).toBeLessThan(0)
  expect(sumCents(deltasOf(l))).toBe(0)
 },T)
})

describe('parallel games',()=>{
 it('counts each game in slot order, both rated from the start-of-round snapshot',async()=>{
  const db=await streakDb(),players=await db.users('alice','bob','carol','dave'),[a,b]=players
  const tid=await rpcTable(db,'single_double',players)
  await rpcRound(db,tid,players,[a,a])
  const [g1,g2]=await rpcRound(db,tid,players,[a,a])
  expect(await snapshotOf(db,g1)).toEqual(await snapshotOf(db,g2))
  expect((await snapshotOf(db,g1)).map(x=>x.rating)).toEqual((await db.rows<{r:number}>(`select rating_at_start as r from public.round_players rp join public.round_games g on g.round_id=rp.round_id where g.id=$1 order by rp.user_id`,[g1])).map(x=>x.r))
  await expectNormal(db,g1,{[a]:3}) // 3rd loss
  await expectPenalized(db,g2,a,4) // 4th loss, same snapshot
  // A game left unresolved changes nothing; the next result continues the count.
  const [g3,open]=await rpcRound(db,tid,players,[a,null])
  await expectPenalized(db,g3,a,5);expect(await ledgerOf(db,open)).toEqual({})
  expect((await streaks(db,'single_double'))[a]).toBe(5)
  // Winning Game 1 resets the count before Game 2 of the same round.
  const [g5,g6]=await rpcRound(db,tid,players,[b,a])
  await expectNormal(db,g5,{[a]:0});await expectNormal(db,g6,{[a]:1})
 },T)

 it('works in Double Double as well',async()=>{
  const db=await streakDb(),players=await db.users('alice','bob','carol'),[a]=players
  const tid=await rpcTable(db,'double_double',players)
  await rpcRound(db,tid,players,[a,a])
  const [g3,g4]=await rpcRound(db,tid,players,[a,a])
  const [g5,g6]=await rpcRound(db,tid,players,[a,a])
  await expectNormal(db,g3,{[a]:3})
  await expectPenalized(db,g4,a,4);await expectPenalized(db,g5,a,5);await expectPenalized(db,g6,a,6)
  expect(await penalizedGames(db)).toEqual([g4,g5,g6].sort())
 },T)
})

describe('corrections and replay',()=>{
 it('recalculates later streaks when a loss is voided',async()=>{
  const db=await streakDb(),[a,b,c]=await db.users('alice','bob','carol'),players=[a,b,c]
  const tid=await rpcTable(db,'natural',players)
  const games:string[]=[]
  for(let i=0;i<4;i++)games.push((await rpcRound(db,tid,players,[a]))[0])
  expect(await penalizedGames(db)).toEqual([games[3]])
  await rpcCorrection(db,games[1],[b,c],true)
  expect(await penalizedGames(db)).toEqual([]) // the 4th loss is now only the 3rd
  await expectNormal(db,games[3],{[a]:3})
  expect((await streaks(db,'natural'))[a]).toBe(3)
  const [next]=await rpcRound(db,tid,players,[a])
  await expectPenalized(db,next,a,4)
 },T)

 it('joins two runs when the win between them is voided, and ignores a rejected correction',async()=>{
  const db=await streakDb(),[a,b,c]=await db.users('alice','bob','carol'),players=[a,b,c]
  const tid=await rpcTable(db,'natural',players)
  for(let i=0;i<3;i++)await rpcRound(db,tid,players,[a])
  const [win]=await rpcRound(db,tid,players,[b])
  const [loss]=await rpcRound(db,tid,players,[a])
  await expectNormal(db,loss,{[a]:1})
  await rpcCorrection(db,loss,[b,c],false) // rejected: nothing changes
  await expectNormal(db,loss,{[a]:1})
  await rpcCorrection(db,win,[a,c],true)
  await expectPenalized(db,loss,a,4)
 },T)

 it('places a reopened vote at its round\'s place in the streak',async()=>{
  const db=await streakDb(),[a,b,c]=await db.users('alice','bob','carol'),players=[a,b,c]
  const t1=await rpcTable(db,'natural',players),t2=await rpcTable(db,'natural',players)
  for(let i=0;i<3;i++)await rpcRound(db,t1,players,[a])
  const [open]=await rpcRound(db,t1,players,[null])
  const [later]=await rpcRound(db,t2,players,[a])
  await expectPenalized(db,later,a,4)
  await db.rpc(a,'restart_unresolved',[open])
  for(const v of [a,c])await db.rpc(v,'cast_vote',[open,b]) // the older game: bob lost, alice won
  await expectNormal(db,open,{[a]:0,[b]:1})
  await expectNormal(db,later,{[a]:1}) // no longer the 4th loss in a row
 },T)

 it('is deterministic: replaying gives identical ratings, ledger and streaks',async()=>{
  const db=await streakDb(),players=await db.users('alice','bob','carol','dave'),[a,b,c,d]=players
  const tid=await rpcTable(db,'single_double',players)
  await rpcRound(db,tid,players,[a,a]);await rpcRound(db,tid,players,[a,b]);await rpcRound(db,tid,players,[a,a])
  await rpcTiedRound(db,await rpcTable(db,'double_single',players),players,[c,d])
  const once=await db.ratingState()
  for(let i=0;i<3;i++)await db.rebuildAll()
  expect(await db.ratingState()).toEqual(once)
  expect(await db.rows(`select * from public.ratings order by mode,user_id`)).toEqual(once.ratings)
 },T)
})

// TypeScript replay with the same semantics as the SQL, for random histories.
type Game={losers:string[];state?:'confirmed'|'tied'|'void'|'unresolved';id?:string}
type Round={mode:Mode;players:string[];games:Game[];startedAt?:Date}
const rated=(g:Game)=>{const s=g.state??(g.losers.length>1?'tied':'confirmed');return s==='confirmed'||s==='tied'}
function replay(history:Round[],mode:Mode,users:string[],from:Date){
 const s=Object.fromEntries(users.map(u=>[u,{cents:120000,games:0,losses:0,streak:0}]))
 const ledger:Record<string,Record<string,{delta:number;extra:number;streak:number|null}>>={}
 for(const r of history.filter(h=>h.mode===mode)){
  const snapshot=r.players.map(id=>({id,rating:s[id].cents/100})),round:Record<string,number>={},covered=r.startedAt!>=from
  for(const g of r.games.filter(rated)){
   const pen=covered?g.losers.filter(id=>s[id].streak+1>=4):[]
   const {delta,extra}=covered?streakDeltas(snapshot,g.losers,pen,20,tieKey(g.id!)):{delta:ratingDeltas(snapshot,g.losers,20,tieKey(g.id!)),extra:{} as Record<string,number>}
   if(covered)for(const id of r.players)s[id].streak=g.losers.includes(id)?s[id].streak+1:0
   ledger[g.id!]=Object.fromEntries(r.players.map(id=>[id,{delta:delta[id],extra:extra[id]??0,streak:covered?s[id].streak:null}]))
   for(const id of r.players){round[id]=(round[id]??0)+cents(delta[id]);s[id].games++}
   g.losers.forEach(id=>s[id].losses++)
  }
  for(const [id,c] of Object.entries(round))s[id].cents+=c
 }
 return {s,ledger}
}
function rng(seed:number){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}

describe('random histories against the reference',()=>{
 it('matches to the cent, before and after the activation point, with exact zero-sum games',async()=>{
  const db=await Db.create();await db.setFormula('v2')
  const users=await db.users(...Array.from({length:8},(_,i)=>`player${i}`)),rand=rng(11),history:Round[]=[]
  // Each mode has an unlucky player who sits at every table and loses most games, so long streaks happen.
  for(let t=0;t<90;t++){
   const mi=Math.floor(rand()*4),mode=MODES[mi],n=3+Math.floor(rand()*6)
   const players=[users[mi],...users.filter(u=>u!==users[mi]).sort(()=>rand()-0.5).slice(0,n-1)]
   const loser=()=>rand()<0.6?players[0]:players[Math.floor(rand()*n)]
   const games:Game[]=[]
   for(let s=0;s<(mode==='single_double'||mode==='double_double'?2:1);s++){
    const x=rand()
    games.push(x<0.08?{losers:[],state:'unresolved'}:x<0.14?{losers:[loser()],state:'void'}:x<0.3&&n>=4?{losers:[players[0],players[1+Math.floor(rand()*(n-1))]]}:{losers:[loser()]})
   }
   const r:Round={mode,players,games};const {gameIds,startedAt}=await db.insertRound(mode,players,games);games.forEach((g,i)=>g.id=gameIds[i]);r.startedAt=startedAt
   history.push(r)
  }
  const from=history[30].startedAt!
  await activate(db,from);await db.rebuildAll()
  let penalized=0
  for(const mode of MODES){
   const {s,ledger}=replay(history,mode,users,from),got=await db.ratings(mode),st=await streaks(db,mode)
   for(const u of users){
    expect(cents(got[u].rating),`${mode} rating of ${u}`).toBe(s[u].cents)
    expect([got[u].games,got[u].losses,st[u]]).toEqual([s[u].games,s[u].losses,s[u].streak])
   }
   for(const [game,want] of Object.entries(ledger)){
    const l=await ledgerOf(db,game)
    expect(sumCents(deltasOf(l)),`sum of ${game}`).toBe(0)
    for(const [u,w] of Object.entries(want)){
     expect([cents(l[u].delta),cents(l[u].streak_extra),l[u].loss_streak],`${game}/${u}`).toEqual([cents(w.delta),cents(w.extra),w.streak])
     if(w.extra<0)penalized++
    }
   }
  }
  expect(penalized).toBeGreaterThan(10)
  // Nothing before the activation point is penalized or counted.
  const early=history.slice(0,30).flatMap(r=>r.games.map(g=>g.id!))
  expect((await db.one<{n:number}>(`select count(*)::int as n from public.rating_ledger where game_id=any($1::uuid[]) and (streak_extra<>0 or loss_streak is not null)`,[early])).n).toBe(0)
  // Deltas are whole cents.
  expect((await db.one<{n:number}>(`select count(*)::int as n from public.rating_ledger where delta::numeric<>round(delta::numeric,2)`)).n).toBe(0)
 },T)
})

describe('per-game SQL formula',()=>{
 const call=async(db:Db,players:string[],ratings:number[],losers:string[],pen:string[],tiebreak:string)=>
  Object.fromEntries((await db.rows<{user_id:string;delta:string;streak_extra:string}>(`select user_id,delta,streak_extra from private.elo_streak_game_deltas($1::uuid[],$2::numeric[],$3::uuid[],20,$4,$5::uuid[])`,
   [players,ratings,losers,tiebreak,pen])).map(r=>[r.user_id,{delta:Number(r.delta),extra:Number(r.streak_extra)}]))
 it('equals plain V2 with nobody penalized and matches the reference otherwise (300 random games)',async()=>{
  const db=await Db.create(),ids=await db.users(...Array.from({length:16},(_,i)=>`player${i}`)),rand=rng(5)
  for(let t=0;t<300;t++){
   const n=3+Math.floor(rand()*14),players=ids.slice(0,n)
   const ratings=players.map(()=>t%4===0?1200:Math.round((900+rand()*700)*100)/100)
   const m=rand()<0.3?Math.min(Math.floor(n/2),2+Math.floor(rand()*3)):1,losers=[...players].sort(()=>rand()-0.5).slice(0,m)
   const pen=t%5===0?[]:losers.filter((_,i)=>i===0||rand()<0.5),key=`game${t}`
   const sql=await call(db,players,ratings,losers,pen,key),participants=players.map((id,i)=>({id,rating:ratings[i]}))
   const plain=ratingDeltas(participants,losers,20,tieKey(key)),ref=streakDeltas(participants,losers,pen,20,tieKey(key))
   let sum=0,extra=0
   for(const id of players){
    expect([cents(sql[id].delta),cents(sql[id].extra)],`game ${t} ${id}`).toEqual([cents(ref.delta[id]),cents(ref.extra[id])])
    expect(cents(sql[id].delta)-cents(sql[id].extra)).toBe(cents(plain[id]))
    if(!pen.length||(losers.includes(id)&&!pen.includes(id)))expect(sql[id].extra).toBe(0)
    if(pen.includes(id)){expect(sql[id].extra).toBeLessThanOrEqual(0);expect(Math.abs(cents(sql[id].extra)-0.25*cents(plain[id]))).toBeLessThan(1)}
    if(!losers.includes(id))expect(sql[id].extra).toBeGreaterThanOrEqual(0)
    sum+=cents(sql[id].delta);extra+=cents(sql[id].extra)
   }
   expect([sum,extra],`game ${t}`).toEqual([0,0])
  }
 },T)
 it('splits the extra in proportion to the winners\' normal gains',async()=>{
  const db=await Db.create(),[a,b,c,d]=await db.users('alice','bob','carol','dave')
  const r=await call(db,[a,b,c,d],[1200,1000,1200,1400],[a],[a],'x')
  const plain=ratingDeltas([{id:a,rating:1200},{id:b,rating:1000},{id:c,rating:1200},{id:d,rating:1400}],[a],20,tieKey('x'))
  // The weakest winner gained most normally, so gets the biggest share.
  expect(r[b].extra).toBeGreaterThan(r[c].extra);expect(r[c].extra).toBeGreaterThan(r[d].extra)
  for(const w of [b,c,d])expect(Math.abs(r[w].extra-(-r[a].extra)*plain[w]/-plain[a])).toBeLessThanOrEqual(0.01)
 },T)
 it('rejects a penalty for someone who did not lose',async()=>{
  const db=await Db.create(),[a,b,c]=await db.users('alice','bob','carol')
  await expect(call(db,[a,b,c],[1200,1200,1200],[a],[b],'x')).rejects.toThrow(/Invalid streak penalty list/)
 },T)
})

describe('activation point and migration safety',()=>{
 it('applying the migration and replaying with the rule off changes nothing',async()=>{
  const db=await productionLike()
  // In production's order: everything else (the later-numbered rating history included) first.
  for(const f of migrationFiles())if(f>=V2_MIGRATION&&f!==STREAK_MIGRATION)await db.applyMigration(f)
  await db.setFormula('v2');await db.rebuildAll()
  const shape=async()=>({ratings:await db.rows(`select user_id,mode,rating,games,losses from public.ratings order by mode,user_id`),
   ledger:await db.rows(`select game_id,user_id,mode,delta,recorded_at from public.rating_ledger order by mode,game_id,user_id`)})
  const before={rating:await shape(),records:await db.gameRecords()}
  await db.applyMigration(STREAK_MIGRATION)
  expect(await shape()).toEqual(before.rating)
  expect((await db.one(`select streak_rule,streak_from from private.rating_config`))).toEqual({streak_rule:'off',streak_from:null})
  await db.rebuildAll()
  expect(await shape()).toEqual(before.rating)
  expect(await db.gameRecords()).toEqual(before.records)
  expect((await db.one<{n:number}>(`select count(*)::int as n from public.rating_ledger where streak_extra<>0 or loss_streak is not null`)).n).toBe(0)
  expect((await db.one<{n:number}>(`select count(*)::int as n from public.ratings where loss_streak<>0`)).n).toBe(0)
 },T)

 it('keeps older games as they were and starts every count at zero',async()=>{
  const db=await Db.create();await db.setFormula('v2')
  const [a,b,c]=await db.users('alice','bob','carol')
  for(let i=0;i<6;i++)await db.insertRound('natural',[a,b,c],[{losers:[a]}]) // six losses in a row, long ago
  await db.rebuildAll()
  const before=await db.ratingState()
  await activate(db);await db.rebuildAll()
  expect(await db.ratingState()).toEqual(before)
  expect((await streaks(db,'natural'))[a]).toBe(0)
  const [g]=await rpcRound(db,await rpcTable(db,'natural',[a,b,c]),[a,b,c],[a])
  await expectNormal(db,g,{[a]:1}) // the first loss since activation
 },T)

 it('treats a round started before activation as before it, even when its result comes later',async()=>{
  const db=await Db.create();await db.setFormula('v2')
  const [a,b,c,d,e]=await db.users('alice','bob','carol','dave','erin')
  const t0=await rpcTable(db,'natural',[a,b,c])
  await db.rpc(a,'start_round',[t0]);await db.rpc(a,'begin_results',[t0])
  const {id:old}=await db.one<{id:string}>(`select g.id from public.round_games g join public.tables t on t.current_round_id=g.round_id where t.id=$1`,[t0])
  await activate(db)
  const t1=await rpcTable(db,'natural',[a,d,e])
  for(let i=0;i<3;i++)await rpcRound(db,t1,[a,d,e],[a])
  for(const v of [b,c])await db.rpc(v,'cast_vote',[old,a]) // a loss, rated as before activation
  await expectNormal(db,old,{[a]:null,[b]:null,[c]:null})
  expect((await streaks(db,'natural'))[a]).toBe(3)
  const [g]=await rpcRound(db,t1,[a,d,e],[a])
  await expectPenalized(db,g,a,4)
 },T)

 it('keeps the History running balance consistent across the activation point',async()=>{
  const db=await Db.create();await db.setFormula('v2')
  const [a,b,c]=await db.users('alice','bob','carol'),players=[a,b,c]
  const tid=await rpcTable(db,'natural',players)
  for(let i=0;i<3;i++)await rpcRound(db,tid,players,[a])
  await activate(db)
  for(let i=0;i<5;i++)await rpcRound(db,tid,players,[a])
  for(const u of players){
   const rows=(await db.rpcRows<{delta:string;rating_before:string;rating_after:string;mode:Mode}>(u,'my_game_history',[null,50])).reverse()
   let last=120000
   for(const r of rows){expect(cents(r.rating_before)).toBe(last);expect(cents(r.rating_after)-cents(r.rating_before)).toBe(cents(r.delta));last=cents(r.rating_after)}
   expect(last).toBe(cents((await db.ratings('natural'))[u].rating))
  }
 },T)
})

describe('History and access',()=>{
 type H={game_id:string;delta:string;loss_streak:number|null;streak_extra:string;streak_penalty:boolean}
 it('marks penalized games and shows each player\'s share from the ledger',async()=>{
  const db=await streakDb(),[a,b,c]=await db.users('alice','bob','carol'),players=[a,b,c]
  const tid=await rpcTable(db,'natural',players)
  const games:string[]=[]
  for(let i=0;i<4;i++)games.push((await rpcRound(db,tid,players,[a]))[0])
  const mine=await db.rpcRows<H>(a,'my_game_history',[null,20]),theirs=await db.rpcRows<H>(b,'my_game_history',[null,20])
  expect(mine.map(r=>r.streak_penalty)).toEqual([true,false,false,false])
  expect(mine.map(r=>r.loss_streak)).toEqual([4,3,2,1])
  const l=await ledgerOf(db,games[3])
  expect([cents(mine[0].delta),cents(mine[0].streak_extra)]).toEqual([cents(l[a].delta),cents(l[a].streak_extra)])
  expect(Number(mine[0].streak_extra)).toBeLessThan(0)
  expect(theirs[0]).toMatchObject({game_id:games[3],streak_penalty:true,loss_streak:0})
  expect(Number(theirs[0].streak_extra)).toBeGreaterThan(0)
  const details=await db.rpc<{streak_penalty:boolean;players:{user_id:string;delta:number;loss_streak:number;streak_extra:number}[]}>(c,'game_details',[games[3]])
  expect(details.streak_penalty).toBe(true)
  for(const p of details.players)expect([cents(p.delta),cents(p.streak_extra),p.loss_streak]).toEqual([cents(l[p.user_id].delta),cents(l[p.user_id].streak_extra),l[p.user_id].loss_streak])
  expect((await db.rpc<{streak_penalty:boolean}>(c,'game_details',[games[0]])).streak_penalty).toBe(false)
 },T)

 it('keeps the new function and the switch away from browser roles',async()=>{
  const db=await Db.create()
  for(const fn of ['private.elo_streak_game_deltas(uuid[],numeric[],uuid[],numeric,text,uuid[])','private.elo_v2_replay(public.durak_mode,numeric)','private.rebuild_mode_v2(public.durak_mode)','private.rebuild_mode(public.durak_mode)'])
   for(const role of ['anon','authenticated'])
    expect((await db.one<{ok:boolean}>(`select has_function_privilege($1,$2,'execute') as ok`,[role,fn])).ok,`${role} ${fn}`).toBe(false)
  for(const role of ['anon','authenticated'])
   expect((await db.one<{ok:boolean}>(`select has_table_privilege($1,'private.rating_config','select,update') as ok`,[role])).ok).toBe(false)
  for(const fn of ['public.my_game_history(uuid,integer)','public.game_details(uuid)']){
   expect((await db.one<{ok:boolean}>(`select has_function_privilege('anon',$1,'execute') as ok`,[fn])).ok).toBe(false)
   expect((await db.one<{ok:boolean}>(`select has_function_privilege('authenticated',$1,'execute') as ok`,[fn])).ok).toBe(true)
  }
 },T)

 it('clears streaks when ratings go back to V1',async()=>{
  const db=await streakDb(),[a,b,c]=await db.users('alice','bob','carol'),players=[a,b,c]
  const tid=await rpcTable(db,'natural',players)
  for(let i=0;i<4;i++)await rpcRound(db,tid,players,[a])
  await db.setFormula('v1');await db.rebuildAll()
  expect((await streaks(db,'natural'))[a]).toBe(0)
  expect(await penalizedGames(db)).toEqual([])
 },T)
})
