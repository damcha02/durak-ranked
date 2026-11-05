// Friends (migration 202611050003): requests, and hosts seating friends at a table.
import {describe,it,expect} from 'vitest'
import {Db} from './sql/db'
import {rpcTable} from './sql/flows'

const T=120_000
const friends=(db:Db,uid:string)=>db.asUser(uid,()=>db.rows<{user_a:string;user_b:string;status:string}>(`select user_a,user_b,status from public.friendships`))

describe('friend requests',()=>{
 it('needs the other person to accept, and a mutual request accepts at once',async()=>{
  const db=await Db.create(),[a,b,c]=await db.users('alice','bob','carol')
  await db.rpc(a,'send_friend_request',['Bob'])
  expect((await friends(db,a))[0].status).toBe('pending')
  await expect(db.rpc(a,'respond_friend_request',[b,true])).rejects.toThrow(/No such friend request/)
  await db.rpc(b,'respond_friend_request',[a,true])
  expect((await friends(db,a))[0].status).toBe('accepted')
  await db.rpc(a,'send_friend_request',['carol']);await db.rpc(c,'send_friend_request',['alice'])
  expect((await friends(db,c)).filter(f=>f.status==='accepted')).toHaveLength(1)
  expect(await friends(db,b)).toHaveLength(1) // bob sees only his own
 },T)

 it('rejects unknown names and yourself, declines and removes',async()=>{
  const db=await Db.create(),[a,b]=await db.users('alice','bob')
  await expect(db.rpc(a,'send_friend_request',['nobody'])).rejects.toThrow(/No player/)
  await expect(db.rpc(a,'send_friend_request',['alice'])).rejects.toThrow(/yourself/)
  await db.rpc(a,'send_friend_request',['bob']);await db.rpc(b,'respond_friend_request',[a,false])
  expect(await friends(db,a)).toHaveLength(0)
  await db.rpc(a,'send_friend_request',['bob']);await db.rpc(b,'respond_friend_request',[a,true]);await db.rpc(b,'remove_friend',[a])
  expect(await friends(db,a)).toHaveLength(0)
 },T)
})

describe('adding friends to a table',()=>{
 it('lets the host seat accepted friends only, in the lobby, up to the table size',async()=>{
  const db=await Db.create(),[a,b,c]=await db.users('alice','bob','carol')
  const tid=await rpcTable(db,'natural',[a])
  await expect(db.rpc(a,'add_friend_to_table',[tid,b])).rejects.toThrow(/only add friends/)
  await db.rpc(a,'send_friend_request',['bob']);await db.rpc(b,'respond_friend_request',[a,true])
  await expect(db.rpc(b,'add_friend_to_table',[tid,a])).rejects.toThrow(/Only the host/)
  await db.rpc(a,'add_friend_to_table',[tid,b]);await db.rpc(a,'add_friend_to_table',[tid,b]) // repeat is harmless
  expect((await db.one<{n:number}>(`select count(*)::int n from public.table_members where table_id=$1 and is_active`,[tid])).n).toBe(2)
  await db.asUser(b,async()=>{expect(await db.rows(`select id from public.tables where id=$1`,[tid])).toHaveLength(1)})
  await db.rpc(a,'kick_member',[tid,b]);await db.rpc(a,'add_friend_to_table',[tid,b]) // can be seated again
  await db.rpc(a,'send_friend_request',['carol']);await db.rpc(c,'respond_friend_request',[a,true])
  await db.rpc(c,'join_table',[(await db.one<{code:string}>(`select code from public.tables where id=$1`,[tid])).code])
  await db.rpc(a,'start_round',[tid])
  await expect(db.rpc(a,'add_friend_to_table',[tid,c])).rejects.toThrow(/between games/)
 },T)
})
