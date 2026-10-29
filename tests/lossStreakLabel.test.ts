import {describe,it,expect} from 'vitest'
import {streakLabel,streakPenaltyNext} from '../src/lossStreak'

describe('losing-streak labels',()=>{
 it('show nothing without a streak, the count, a warning before the 4th loss, then the penalty',()=>{
  expect([null,undefined,0].map(streakLabel)).toEqual(['','',''])
  expect(streakLabel(1)).toBe('1-loss streak');expect(streakLabel(2)).toBe('2-loss streak')
  expect(streakLabel(3)).toBe('3-loss streak · next loss +25%')
  expect(streakLabel(4)).toBe('4-loss streak · +25% penalty');expect(streakLabel(9)).toBe('9-loss streak · +25% penalty')
  expect([2,3,4].map(streakPenaltyNext)).toEqual([false,true,true])
 })
})
