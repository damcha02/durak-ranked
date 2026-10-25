import {describe,expect,it} from 'vitest'
import {readTheme,saveTheme} from '../src/theme'

const memory=()=>{const data=new Map<string,string>();return {getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v)}}}
const broken={getItem:()=>{throw new Error('blocked')},setItem:()=>{throw new Error('blocked')}}

describe('theme preference',()=>{
  it('defaults to the cards theme',()=>{
    expect(readTheme(memory())).toBe('cards')
    expect(readTheme(undefined)).toBe('cards')
  })
  it('remembers the light-blue theme',()=>{
    const store=memory();saveTheme('blue',store)
    expect(readTheme(store)).toBe('blue')
    saveTheme('cards',store)
    expect(readTheme(store)).toBe('cards')
  })
  it('ignores unknown stored values',()=>{
    const store=memory();store.setItem('durak-ranked-theme','neon')
    expect(readTheme(store)).toBe('cards')
  })
  it('survives storage that throws',()=>{
    expect(readTheme(broken)).toBe('cards')
    expect(()=>saveTheme('blue',broken)).not.toThrow()
  })
})
