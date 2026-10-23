// Optional scheduled connectivity check. This is not a guaranteed pause-prevention mechanism.
// Publishable key only; NEVER use the Supabase service_role key.
export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      const url = `${env.SUPABASE_URL}/rest/v1/service_heartbeat?select=label&limit=1`
      try {
        const result = await fetch(url, {
          headers: { 'apikey': env.SUPABASE_PUBLISHABLE_KEY },
          cf: { cacheTtl: 0 }
        })
        if (!result.ok) console.error('Supabase health query failed:', result.status, (await result.text()).slice(0, 300))
        else console.log('Supabase database check succeeded')
      } catch (e) { console.error('Supabase health query failed:', String(e)) }
    })())
  }
}
