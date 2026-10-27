export type Theme='cards'|'blue'
export const THEMES:{id:Theme;name:string;description:string;color:string}[]=[
  {id:'blue',name:'Light blue',description:'Calm blue with white cards',color:'#e8f1f8'},
  {id:'cards',name:'Cards',description:'Card stock, ink and forest green',color:'#ece6da'}
]
const KEY='durak-ranked-theme'
export type Store=Pick<Storage,'getItem'|'setItem'>

// Light blue is the default; only an explicit "cards" choice switches it.
// The theme is a per-device convenience: storage can be missing or throw (private mode, blocked site data).
export const defaultStore=():Store|undefined=>{try{return globalThis.localStorage}catch{return undefined}}

export function readTheme(store:Store|undefined=defaultStore()):Theme{
  try{return store?.getItem(KEY)==='cards'?'cards':'blue'}catch{return 'blue'}
}
export function saveTheme(theme:Theme,store:Store|undefined=defaultStore()):void{
  try{store?.setItem(KEY,theme)}catch{/* not persisted; the choice still applies until reload */}
}
export function applyTheme(theme:Theme,doc:Document=document):void{
  doc.documentElement.dataset.theme=theme
  doc.querySelector('meta[name="theme-color"]')?.setAttribute('content',THEMES.find(t=>t.id===theme)!.color)
}
