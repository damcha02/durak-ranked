import {key,supabase,url} from './lib'

/** Supabase Auth validates the password. This function only resolves the username. */
export async function signInByUsername(username: string, password: string): Promise<void> {
  const res = await fetch(`${url}/functions/v1/username-signin`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ username, password }),
  })
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok || !body || typeof body !== 'object') {
    if (res.status === 429) throw new Error('Too many sign-in attempts. Try again later.')
    if (res.status === 404) throw new Error('Username login has not been deployed yet. Use your email to sign in.')
    throw new Error('Invalid username or password, or username login is unavailable.')
  }
  const tokens = body as {access_token?: unknown;refresh_token?: unknown}
  if (typeof tokens.access_token !== 'string' || typeof tokens.refresh_token !== 'string') {
    throw new Error('Unexpected authentication response')
  }
  const {error} = await supabase.auth.setSession({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
  })
  if (error) throw error
}
