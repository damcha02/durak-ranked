export function expected(a:number,b:number){return 1/(1+Math.pow(10,(b-a)/400))}
/** Returns point deltas; each validated game is zero-sum. Shared losses carry half weight. */
export function ratingDeltas(participants:{id:string;rating:number}[],loserIds:string[],k=32):Record<string,number>{
 const n=participants.length
 if(n<2 || !loserIds.length || loserIds.length>=n || new Set(loserIds).size!==loserIds.length)throw Error('Invalid participants / losers')
 const losers=participants.filter(p=>loserIds.includes(p.id)),winners=participants.filter(p=>!loserIds.includes(p.id))
 if(losers.length!==loserIds.length)throw Error('Unknown loser')
 const result:Record<string,number> = Object.fromEntries(participants.map(p=>[p.id,0]))
 const multiplier=losers.length===1?1:0.5
 for(const loser of losers){for(const winner of winners){
   const gain=multiplier*k/(n-1)*(1-expected(winner.rating,loser.rating))
   result[winner.id]+=gain;result[loser.id]-=gain
 }}
 return result
}
