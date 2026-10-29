// Losing-streak labels for Profile and History. The server decides every penalty (rule loss_streak_v1,
// see docs/LOSS_STREAK.md); the app only shows the count and the amounts from the rating ledger.
import {STREAK_THRESHOLD,STREAK_FACTOR} from './rating'

const PERCENT=`+${Math.round((STREAK_FACTOR-1)*100)}%`
/** "4-loss streak · +25% penalty" once losses cost more, a warning one loss before, the bare count below that. */
export function streakLabel(streak:number|null|undefined):string{
 const n=streak??0
 if(n<=0)return ''
 if(n>=STREAK_THRESHOLD)return `${n}-loss streak · ${PERCENT} penalty`
 if(n===STREAK_THRESHOLD-1)return `${n}-loss streak · next loss ${PERCENT}`
 return `${n}-loss streak`
}
/** True once the player's next loss in the mode costs more. */
export const streakPenaltyNext=(streak:number|null|undefined)=>(streak??0)>=STREAK_THRESHOLD-1
