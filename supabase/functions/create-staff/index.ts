// create-staff — owner-only admin Edge Function (SPEC §6.11, §9).
//
// Why this exists: creating a login (an auth.users row) needs the service-role
// key, which must never reach the browser. And the handle_new_user signup
// trigger deliberately refuses self-assigned 'owner'/'staff' roles — so staff
// can only be created by a privileged server path that:
//   1. verifies the caller is an owner (using THEIR jwt, not the service key),
//   2. creates the auth user with the service key,
//   3. promotes the freshly-created profile to role = 'staff' in the owner's shop.
//
// Deploy:  supabase functions deploy create-staff
// (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const url = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

  // --- 1. Identify the caller from their bearer token, under their own RLS. ---
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader) return json({ error: 'Not signed in.' }, 401)

  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: userData, error: userErr } = await asCaller.auth.getUser()
  if (userErr || !userData?.user) return json({ error: 'Not signed in.' }, 401)

  const { data: caller, error: callerErr } = await asCaller
    .from('profiles')
    .select('role, shop_id')
    .eq('id', userData.user.id)
    .maybeSingle()
  if (callerErr) return json({ error: callerErr.message }, 400)
  if (caller?.role !== 'owner') return json({ error: 'Only the owner can add staff.' }, 403)
  if (!caller.shop_id) return json({ error: 'Your account is not linked to a shop.' }, 400)

  // --- 2. Validate input. ---
  let body: { full_name?: string; phone?: string; email?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid request body.' }, 400)
  }
  const full_name = (body.full_name ?? '').trim()
  const phone = (body.phone ?? '').trim()
  const email = (body.email ?? '').trim().toLowerCase()
  const password = body.password ?? ''

  if (!full_name) return json({ error: 'Enter the staff member’s name.' }, 400)
  if (!email) return json({ error: 'Enter an email for the staff login.' }, 400)
  if (password.length < 6) return json({ error: 'Use a password of at least 6 characters.' }, 400)

  // --- 3. Create the login + promote to staff, with the service-role key. ---
  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // owner vouches for them — skip the confirmation email.
    user_metadata: { full_name, phone },
  })
  if (createErr) {
    const msg = /already.*registered|already.*exists/i.test(createErr.message)
      ? 'This email already has an account.'
      : createErr.message
    return json({ error: msg }, 400)
  }

  const newId = created.user!.id

  // The handle_new_user trigger has already inserted a 'customer' profile row.
  // Promote it to staff and bind it to THIS owner's shop.
  const { error: promoteErr } = await admin
    .from('profiles')
    .update({ role: 'staff', full_name, phone: phone || null, shop_id: caller.shop_id, is_active: true })
    .eq('id', newId)
  if (promoteErr) {
    // Roll back the orphaned login so a half-made account can't linger.
    await admin.auth.admin.deleteUser(newId)
    return json({ error: promoteErr.message }, 400)
  }

  return json({ ok: true, id: newId, full_name, email })
})
