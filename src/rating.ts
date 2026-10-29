// Reference implementations of the server-side Elo (private.rebuild_mode_v1 / elo_v2_game_deltas).
// The database is authoritative; these mirror it for tests and documentation.
type Participant={id:string;rating:number}
function validate(participants:Participant[],loserIds:string[]){
 const n=participants.length
 if(n<2 || new Set(participants.map(p=>p.id)).size!==n)throw Error('Invalid participants')
 if(!loserIds.length || loserIds.length>=n || new Set(loserIds).size!==loserIds.length)throw Error('Invalid participants / losers')
 if(!loserIds.every(id=>participants.some(p=>p.id===id)))throw Error('Unknown loser')
}

const cmp=(a:string,b:string)=>a<b?-1:a>b?1:0

export function expected(a:number,b:number){return 1/(1+Math.pow(10,(b-a)/400))}
/** V1 (live until V2 is activated): each winner gains K/(n-1)*(1-E) from each loser; shared losses carry half weight. */
export function ratingDeltasV1(participants:Participant[],loserIds:string[],k=32):Record<string,number>{
 validate(participants,loserIds)
 const n=participants.length
 const losers=participants.filter(p=>loserIds.includes(p.id)),winners=participants.filter(p=>!loserIds.includes(p.id))
 const result:Record<string,number> = Object.fromEntries(participants.map(p=>[p.id,0]))
 const multiplier=losers.length===1?1:0.5
 for(const loser of losers){for(const winner of winners){
   const gain=multiplier*k/(n-1)*(1-expected(winner.rating,loser.rating))
   result[winner.id]+=gain;result[loser.id]-=gain
 }}
 return result
}

/** V2: each player's chance of being the Durak, p_i ∝ 10^(-R_i/400). Sums to 1. */
export function lossProbabilities(ratings:number[]):number[]{
 const top=Math.max(...ratings),g=ratings.map(r=>Math.pow(10,(top-r)/400)),s=g.reduce((a,b)=>a+b,0)
 return g.map(x=>x/s)
}
/**
 * V2 per-game deltas. Winners gain K*p_i; the losers together lose K*(1-sum p_losers),
 * split in proportion to (1-p). Rounded to 0.01 by largest remainder, so the result sums to
 * exactly zero; cents are snapped to 1e-9 so floating-point noise cannot break exact ties.
 * Exact ties are ordered by tieKey (the server uses md5(game_id || user_id)), then id.
 */
export function ratingDeltas(participants:Participant[],loserIds:string[],k=20,tieKey:(id:string)=>string=id=>id):Record<string,number>{
 validate(participants,loserIds)
 const p=lossProbabilities(participants.map(x=>x.rating)),lost=participants.map(x=>loserIds.includes(x.id))
 const pt=p.reduce((s,x,i)=>lost[i]?s+x:s,0),share=p.reduce((s,x,i)=>lost[i]?s+1-x:s,0)
 // Integer nano-cents keep the floor/remainder split exact.
 const cents=participants.map((x,i)=>{const nano=Math.round(1e11*(lost[i]?-k*(1-pt)*(1-p[i])/share:k*p[i])),f=Math.floor(nano/1e9);return{id:x.id,key:tieKey(x.id),f,frac:nano-f*1e9}})
 const missing=-cents.reduce((s,c)=>s+c.f,0)
 const bonus=new Set([...cents].sort((a,b)=>b.frac-a.frac||cmp(a.key,b.key)||cmp(a.id,b.id)).slice(0,missing).map(c=>c.id))
 return Object.fromEntries(cents.map(c=>[c.id,(c.f+(bonus.has(c.id)?1:0))/100]))
}

/** Losing-streak penalty (rule loss_streak_v1): a loss that is at least the 4th in a row in a mode costs 25% more. */
export const STREAK_THRESHOLD=4,STREAK_FACTOR=1.25
/**
 * V2 deltas with the streak penalty on `penalizedIds` (a subset of the losers): each penalized
 * loser's normal delta is multiplied by 1.25 and the extra is shared by the winners in proportion
 * to their normal gains. Same largest-remainder rounding as ratingDeltas, so the game stays exactly
 * zero-sum; `extra` is the part of each delta that comes from the penalty.
 */
export function streakDeltas(participants:Participant[],loserIds:string[],penalizedIds:string[],k=20,tieKey:(id:string)=>string=id=>id):{delta:Record<string,number>;extra:Record<string,number>}{
 if(!penalizedIds.every(id=>loserIds.includes(id)))throw Error('Invalid streak penalty list')
 const normal=ratingDeltas(participants,loserIds,k,tieKey)
 const base=Object.fromEntries(participants.map(x=>[x.id,Math.round(normal[x.id]*100)]))
 const extra=penalizedIds.reduce((s,id)=>s-base[id]*(STREAK_FACTOR-1),0),gains=participants.reduce((s,x)=>loserIds.includes(x.id)?s:s+base[x.id],0)
 const cents=participants.map(x=>{
  const b=base[x.id],raw=penalizedIds.includes(x.id)?b*STREAK_FACTOR:loserIds.includes(x.id)||gains<=0?b:b+extra*b/gains
  const nano=Math.round(raw*1e9),f=Math.floor(nano/1e9);return{id:x.id,key:tieKey(x.id),b,f,frac:nano-f*1e9}
 })
 const missing=-cents.reduce((s,c)=>s+c.f,0)
 const bonus=new Set([...cents].sort((a,b)=>b.frac-a.frac||cmp(a.key,b.key)||cmp(a.id,b.id)).slice(0,missing).map(c=>c.id))
 const final=cents.map(c=>({id:c.id,c:c.f+(bonus.has(c.id)?1:0),b:c.b}))
 return {delta:Object.fromEntries(final.map(x=>[x.id,x.c/100])),extra:Object.fromEntries(final.map(x=>[x.id,(x.c-x.b)/100]))}
}
