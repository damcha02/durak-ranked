// Real game flow through the public RPCs, as the app drives it.
import type {Db,Mode} from './db.ts'

export async function rpcTable(db:Db,mode:Mode,players:string[]){
 const tid=await db.rpc<string>(players[0],'create_table',[mode,null])
 const {code}=await db.one<{code:string}>(`select code from public.tables where id=$1`,[tid])
 for(const p of players.slice(1))await db.rpc(p,'join_table',[code])
 return tid
}
/** Plays one round; each entry is the loser of that game, or null to leave it unresolved. */
export async function rpcRound(db:Db,tid:string,players:string[],losers:(string|null)[]){
 const rid=await db.rpc<string>(players[0],'start_round',[tid])
 await db.rpc(players[0],'begin_results',[tid])
 const games=(await db.rows<{id:string}>(`select id from public.round_games where round_id=$1 order by slot`,[rid])).map(g=>g.id)
 for(const [i,game] of games.entries()){
  const loser=losers[i]
  if(loser){for(const voter of players.slice(0,Math.floor(players.length/2)+1))await db.rpc(voter,'cast_vote',[game,loser])}
  else{await db.rpc(players[0],'cast_vote',[game,players[1]]);await expire(db,game);await db.rpc(players[0],'advance_expired',[game])}
 }
 return games
}
export const expire=(db:Db,game:string)=>db.pg.query(`update public.round_games set deadline=now()-interval '1 second' where id=$1`,[game])
/** Two-way tie in a game of 4+ players, accepted by both tied players. */
export async function rpcTiedRound(db:Db,tid:string,players:string[],tied:[string,string]){
 const rid=await db.rpc<string>(players[0],'start_round',[tid])
 await db.rpc(players[0],'begin_results',[tid])
 const {id:game}=await db.one<{id:string}>(`select id from public.round_games where round_id=$1 and slot=1`,[rid])
 const others=players.filter(p=>!tied.includes(p))
 await db.rpc(others[0],'cast_vote',[game,tied[0]]);await db.rpc(others[1],'cast_vote',[game,tied[0]])
 await db.rpc(tied[0],'cast_vote',[game,tied[1]]);await db.rpc(tied[1],'cast_vote',[game,tied[1]])
 await expire(db,game);await db.rpc(players[0],'advance_expired',[game])
 for(const t of tied)await db.rpc(t,'respond_to_tie',[game,true])
 return game
}
/** Opens a correction on a game and has the first `voters` participants vote on it. */
export async function rpcCorrection(db:Db,game:string,voters:string[],approve:boolean){
 const cid=await db.rpc<string>(voters[0],'request_reversal',[game])
 for(const v of voters)await db.rpc(v,'vote_reversal',[cid,approve])
 return cid
}
