import {describe,expect,it} from 'vitest'
import {readTheme,saveTheme} from '../src/theme'

const memory=()=>{const data=new Map<string,string>();return {getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v)}}}
const broken={getItem:()=>{throw new Error('blocked')},setItem:()=>{throw new Error('blocked')}}

describe('theme preference',()=>{
  it('defaults to the light-blue theme',()=>{
    expect(readTheme(memory())).toBe('blue')
    expect(readTheme(undefined)).toBe('blue')
  })
  it('remembers an explicit choice',()=>{
    const store=memory();saveTheme('cards',store)
    expect(readTheme(store)).toBe('cards')
    saveTheme('blue',store)
    expect(readTheme(store)).toBe('blue')
  })
  it('ignores unknown stored values',()=>{
    const store=memory();store.setItem('durak-ranked-theme','neon')
    expect(readTheme(store)).toBe('blue')
  })
  it('survives storage that throws',()=>{
    expect(readTheme(broken)).toBe('blue')
    expect(()=>saveTheme('blue',broken)).not.toThrow()
  })
})
