export type Theme='cards'|'blue'
export const THEMES:{id:Theme;name:string;description:string;color:string}[]=[
  {id:'cards',name:'Cards',description:'Card stock, ink and forest green',color:'#ece6da'},
  {id:'blue',name:'Light blue',description:'Calm blue with white cards',color:'#e8f1f8'}
]
const KEY='durak-ranked-theme'
type Store=Pick<Storage,'getItem'|'setItem'>

// The theme is a per-device convenience: storage can be missing or throw (private mode, blocked site data).
const defaultStore=():Store|undefined=>{try{return globalThis.localStorage}catch{return undefined}}

export function readTheme(store:Store|undefined=defaultStore()):Theme{
  try{return store?.getItem(KEY)==='blue'?'blue':'cards'}catch{return 'cards'}
}
export function saveTheme(theme:Theme,store:Store|undefined=defaultStore()):void{
  try{store?.setItem(KEY,theme)}catch{/* not persisted; the choice still applies until reload */}
}
export function applyTheme(theme:Theme,doc:Document=document):void{
  doc.documentElement.dataset.theme=theme
  doc.querySelector('meta[name="theme-color"]')?.setAttribute('content',THEMES.find(t=>t.id===theme)!.color)
}
