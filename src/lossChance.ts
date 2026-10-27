// Pre-game losing chance shown at the table: each player's Elo V2 chance of being the Durak,
// p_i = 10^(-R_i/400) / sum_j 10^(-R_j/400). It comes from the same reference implementation
// the server's rating is verified against (tests/lossChance.test.ts checks it against the SQL).
// Display only: the server never reads these numbers.
import {lossProbabilities} from './rating'
import {defaultStore} from './theme'
import type {Store} from './theme'

export type Chance={rating:number;p:number}
/** Chances for the roster in full precision, or null with fewer than 2 players or a missing rating. */
export function lossChances(ids:string[],ratings:Record<string,number|null|undefined>):Record<string,Chance>|null{
 if(ids.length<2||new Set(ids).size!==ids.length||!ids.every(id=>Number.isFinite(ratings[id])))return null
 const p=lossProbabilities(ids.map(id=>ratings[id] as number))
 return Object.fromEntries(ids.map((id,i)=>[id,{rating:ratings[id] as number,p:p[i]}]))
}
/** One decimal for display only. */
export const formatChance=(p:number)=>`${(100*p).toFixed(1)}%`

// Shown by default; anyone can hide it in Profile. A per-device choice, like the theme.
const KEY='durak-ranked-loss-chance'
export function readShowChances(store:Store|undefined=defaultStore()):boolean{
 try{return store?.getItem(KEY)!=='off'}catch{return true}
}
export function saveShowChances(show:boolean,store:Store|undefined=defaultStore()):void{
 try{store?.setItem(KEY,show?'on':'off')}catch{/* not persisted; the choice still applies until reload */}
}
