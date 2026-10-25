import {describe,expect,it} from 'vitest'
import {isEmailIdentifier,isUsername} from '../src/authValidation'

describe('account form validation',()=>{
  it('accepts normal usernames',()=>{
    expect(isUsername('cookie')).toBe(true)
    expect(isUsername('User_2026')).toBe(true)
    expect(isUsername('a'.repeat(22))).toBe(true)
  })
  it('rejects invalid usernames',()=>{
    expect(isUsername('ab')).toBe(false)
    expect(isUsername('a'.repeat(23))).toBe(false)
    expect(isUsername('a b')).toBe(false)
    expect(isUsername('a@b.com')).toBe(false)
  })
  it('distinguishes email and username identifiers',()=>{
    expect(isEmailIdentifier('user@example.com')).toBe(true)
    expect(isEmailIdentifier('cookie')).toBe(false)
  })
})
