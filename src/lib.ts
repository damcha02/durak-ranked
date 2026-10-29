import { createClient } from '@supabase/supabase-js'
export const url = import.meta.env.VITE_SUPABASE_URL || ''
export const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY || ''
export const configured = Boolean(url && key && url.startsWith('https://'))
export const supabase = createClient(configured ? url : 'https://example.supabase.co',key || 'placeholder',{
  auth:{autoRefreshToken:true,persistSession:true,detectSessionInUrl:true}
})
export type Mode = 'natural'|'double_single'|'single_double'|'double_double'
export const MODES: {id:Mode;name:string;detail:string;min:number;max:number;games:number}[]=[
  {id:'natural',name:'Durak',detail:'1 deck · 1 game',min:3,max:8,games:1},
  {id:'double_single',name:'Double Single',detail:'2 combined decks · 1 game',min:3,max:16,games:1},
  {id:'single_double',name:'Single Double',detail:'2 separate decks · 2 parallel games',min:3,max:8,games:2},
  {id:'double_double',name:'Double Double',detail:'4 decks · 2 parallel games',min:3,max:16,games:2}
]
export const modeInfo=(m:Mode)=>MODES.find(x=>x.id===m) || MODES[0]
export const date=(s:string)=>new Date(s).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'})
export type Profile={id:string;username:string;honesty_credit:number;created_at:string}
// closed_at: set by the server once an idle lobby has had no activity for 24 hours; a closed table is final.
export type TableRow={id:string;code:string;mode:Mode;group_id:string|null;host_id:string;status:'lobby'|'playing'|'results';current_round_id:string|null;created_at:string;last_activity_at:string;closed_at:string|null}
export type Member={table_id:string;user_id:string;is_active:boolean;joined_at:string;profiles?:Profile}
export type Round={id:string;table_id:string;started_at:string;state:string;started_by:string}
export type Game={id:string;round_id:string;slot:number;state:'awaiting'|'voting'|'tie_offer'|'confirmed'|'tied'|'unresolved'|'void';deadline:string|null;loser_ids:string[];allowed_nominees:string[]|null;finalized_at:string|null}
// loss_streak: consecutive losses in the mode since the losing-streak penalty was activated (0 before; undefined until the migration is applied).
export type Rating={user_id:string;mode:Mode;rating:number;games:number;losses:number;loss_streak?:number}
export type VoteTotal={game_id:string;nominee_id:string;votes:number}
// Game history (public.my_game_history / public.game_details): Elo values come from the server's rating ledger, rounded to 0.01.
export type Correction='open'|'approved'|'rejected'|'expired'|null
export type HistoryGame={game_id:string;round_id:string;mode:Mode;slot:number;games_in_round:number;state:'confirmed'|'tied'|'void'|'unresolved';played_at:string;finalized_at:string|null;player_count:number;loser_ids:string[];loser_names:string[];delta:number;rating_before:number;rating_after:number;correction:Correction;
 loss_streak?:number|null;streak_extra?:number;streak_penalty?:boolean}
// streak_extra: the part of a delta that comes from a losing-streak penalty (negative for the penalized loser, the winners' shares positive).
export type GameDetails={game_id:string;mode:Mode;slot:number;games_in_round:number;state:Game['state'];played_at:string;finalized_at:string|null;loser_ids:string[];correction:Correction;streak_penalty?:boolean;
 players:{user_id:string;username:string;lost:boolean;delta:number|null;rating_before:number|null;rating_after:number|null;loss_streak?:number|null;streak_extra?:number}[]}
export type Group={id:string;code:string;name:string;owner_id:string;created_at:string}
export function errorMessage(e:unknown){return e instanceof Error?e.message:String(e)}
export async function rpc<T=unknown>(name:string,args:Record<string,unknown>={}):Promise<T>{
  const {data,error}=await supabase.rpc(name,args);if(error)throw new Error(error.message);return data as T
}
