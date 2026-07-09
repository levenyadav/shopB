// create-staff — owner-only admin Edge Function (SPEC §6.11, §9).
//
// Why this exists: creating a login (an auth.users row) needs the service-role
// key, which must never reach the browser. And the handle_new_user signup
// trigger deliberately refuses self-assigned 'owner'/'staff' roles — so staff
// can only be created by a privileged server path that:
//   1. verifies the caller is an owner (using THEIR jwt, not the service key),
//   2. creates the auth user with the service key from the PHONE only — staff
//      have NO email and NO password; they sign in by phone OTP, so profiles.id
//      must == auth.users.id or phone-otp-login's getUserById(profile.id) fails
//      with "Login for this account is not set up". (The email bridge handle the
//      OTP flow needs is added lazily at first login by phone-otp, not here — so
//      a staff record carries no email address.)
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
  let body: { full_name?: string; phone?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid request body.' }, 400)
  }
  const full_name = (body.full_name ?? '').trim()
  // Frontend sends E.164 (+91XXXXXXXXXX). That's the only identity a staff has —
  // no email, no password; they sign in by phone OTP.
  const phone = (body.phone ?? '').trim()
  const digits = phone.replace(/\D/g, '')

  if (!full_name) return json({ error: 'Enter the staff member’s name.' }, 400)
  if (!/^\+\d{10,15}$/.test(phone) || digits.length < 10) {
    return json({ error: 'Enter a valid mobile number.' }, 400)
  }

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // --- 3. Refuse duplicates; clean up a legacy login-less profile if present. ---
  // A staff/party signs in by phone OTP, which looks the profile up by phone with
  // .maybeSingle() — so a duplicate phone would break login, and we can't reuse an
  // old random id. If a stale login-less row has no history we replace it.
  const { data: existing, error: existErr } = await admin
    .from('profiles')
    .select('id')
    .eq('phone', phone)
    .maybeSingle()
  if (existErr) return json({ error: existErr.message }, 400)
  if (existing) {
    const { data: stale } = await admin.auth.admin.getUserById(existing.id)
    if (stale?.user) return json({ error: 'This number already has an account.' }, 409)
    const { error: delErr } = await admin.from('profiles').delete().eq('id', existing.id)
    if (delErr) {
      return json({
        error: 'This number was added before logins were set up and now has ' +
          'history. It needs a manual migration — contact support.',
      }, 409)
    }
  }

  // --- 4. Create the login + promote to staff. ---
  // Exactly like create-party: mint the auth user with a shadow <digits>@dev.local
  // email (email_confirm, no password — the owner vouches for them). We do NOT
  // create a phone-only user, because that requires Supabase's own phone provider
  // to be enabled — and it isn't here (login OTPs go through Fast2SMS via
  // phone-otp, which looks the account up by profile.phone and reuses this same
  // shadow email to mint the session). Staff still sign in by phone OTP only.
  const shadowEmail = `${digits}@dev.local`
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: shadowEmail,
    email_confirm: true,
    user_metadata: { full_name, phone, role: 'staff' },
  })
  if (createErr) {
    const msg = /already.*registered|already.*exists/i.test(createErr.message)
      ? 'This number already has an account.'
      : createErr.message
    return json({ error: msg }, 409)
  }

  const newId = created.user!.id

  // The handle_new_user trigger has already inserted a 'customer' profile row.
  // Promote it to staff and bind it to THIS owner's shop. Force email = null so a
  // staff record never carries an email address (it's phone-only).
  const { error: promoteErr } = await admin
    .from('profiles')
    .update({ role: 'staff', full_name, phone, email: null, shop_id: caller.shop_id, is_active: true })
    .eq('id', newId)
  if (promoteErr) {
    // Roll back the orphaned login so a half-made account can't linger.
    await admin.auth.admin.deleteUser(newId)
    return json({ error: promoteErr.message }, 400)
  }

  return json({ ok: true, id: newId, full_name, phone })
})
