// public.friend_rating_history (migration 202611130001): a friend's rating chart, friends only.
import {describe,it,expect} from 'vitest'
import {Db} from './sql/db'
import {rpcTable,rpcRound} from './sql/flows'
import type {RatedGame} from '../src/ratingChart'

const T=120_000
describe('friend rating history',()=>{
 it('matches the friend\'s own history, and is refused to non-friends and pending requests',async()=>{
  const db=await Db.create();await db.setFormula('v2')
  const [a,b,c]=await db.users('alice','bob','carol'),players=[a,b,c]
  await rpcRound(db,await rpcTable(db,'natural',players),players,[b])
  await rpcRound(db,await rpcTable(db,'natural',players),players,[c])
  await db.rpc(a,'send_friend_request',['bob'])
  await expect(db.rpc(a,'friend_rating_history',[b,'natural'])).rejects.toThrow(/only see the rating history of your friends/)
  await db.rpc(b,'respond_friend_request',[a,true])
  const own=await db.rpcRows<RatedGame>(b,'my_rating_history',['natural'])
  const seen=await db.rpcRows<RatedGame>(a,'friend_rating_history',[b,'natural'])
  expect(own).toHaveLength(2)
  expect(seen).toEqual(own)
  expect(await db.rpcRows<RatedGame>(b,'friend_rating_history',[a,'natural'])).toHaveLength(2) // both ways
  expect(await db.rpcRows<RatedGame>(c,'friend_rating_history',[c,'natural'])).toHaveLength(2) // yourself
  await expect(db.rpc(c,'friend_rating_history',[b,'natural'])).rejects.toThrow(/only see/)
  await db.rpc(a,'remove_friend',[b])
  await expect(db.rpc(a,'friend_rating_history',[b,'natural'])).rejects.toThrow(/only see/)
 },T)
})
