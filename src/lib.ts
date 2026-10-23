import { createClient } from '@supabase/supabase-js'
export const url = import.meta.env.VITE_SUPABASE_URL || ''
export const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY || ''
export const configured = Boolean(url && key && url.startsWith('https://'))
export const supabase = createClient(configured ? url : 'https://example.supabase.co',key || 'placeholder',{
  auth:{autoRefreshToken:true,persistSession:true,detectSessionInUrl:true}
})
export type Mode = 'natural'|'double_single'|'single_double'|'double_double'
export const MODES: {id:Mode;name:string;detail:string;min:number;max:number;games:number}[]=[
  {id:'natural',name:'Natural Durak',detail:'1 deck · 1 game',min:3,max:8,games:1},
  {id:'double_single',name:'Double Single',detail:'2 combined decks · 1 game',min:3,max:16,games:1},
  {id:'single_double',name:'Single Double',detail:'2 separate decks · 2 parallel games',min:3,max:8,games:2},
  {id:'double_double',name:'Double Double',detail:'4 decks · 2 parallel games',min:3,max:16,games:2}
]
export const modeInfo=(m:Mode)=>MODES.find(x=>x.id===m) || MODES[0]
export const date=(s:string)=>new Date(s).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'})
export type Profile={id:string;username:string;honesty_credit:number;created_at:string}
export type TableRow={id:string;code:string;mode:Mode;host_id:string;status:'lobby'|'playing'|'results';current_round_id:string|null;created_at:string}
export type Member={table_id:string;user_id:string;is_active:boolean;joined_at:string;profiles?:Profile}
export type Round={id:string;table_id:string;started_at:string;state:string;started_by:string}
export type Game={id:string;round_id:string;slot:number;state:'awaiting'|'voting'|'tie_offer'|'confirmed'|'tied'|'unresolved'|'void';deadline:string|null;loser_ids:string[];allowed_nominees:string[]|null;finalized_at:string|null}
export type Rating={user_id:string;mode:Mode;rating:number;games:number;losses:number}
export type VoteTotal={game_id:string;nominee_id:string;votes:number}
export type Group={id:string;code:string;name:string;owner_id:string;created_at:string}
export function errorMessage(e:unknown){return e instanceof Error?e.message:String(e)}
export async function rpc<T=unknown>(name:string,args:Record<string,unknown>={}):Promise<T>{
  const {data,error}=await supabase.rpc(name,args);if(error)throw new Error(error.message);return data as T
}
