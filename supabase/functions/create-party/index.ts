// create-party — owner/staff Edge Function (SPEC §6.7.2).
//
// Why this exists: a party (customer/dealer) logs in later with phone OTP, and
// EVERY login keys off auth.uid() == profiles.id. So a party is only usable if
// it has an auth.users row whose id equals its profile id. Creating an auth user
// needs the service-role key, which must never reach the browser — and the
// profile row must ADOPT the auth user's id (not a random uuid), or
// firebase-otp-login's getUserById(profile.id) fails with
// "Login for this account is not set up."
//
// So, exactly like create-staff, this:
//   1. verifies the caller is an owner OR staff (using THEIR jwt),
//   2. creates the auth user with the service key (a shadow <digits>@dev.local
//      email — the party has no password; they sign in by phone OTP),
//   3. re-shapes the freshly-triggered profile into a customer/dealer bound to
//      the caller's shop, so profiles.id == auth.users.id.
//
// Deploy:  supabase functions deploy create-party
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
  if (caller?.role !== 'owner' && caller?.role !== 'staff') {
    return json({ error: 'Only the shop can add parties.' }, 403)
  }
  if (!caller.shop_id) return json({ error: 'Your account is not linked to a shop.' }, 400)

  // --- 2. Validate input. ---
  let body: { full_name?: string; phone?: string; type?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid request body.' }, 400)
  }
  const full_name = (body.full_name ?? '').trim()
  // Frontend sends E.164 (+91XXXXXXXXXX). Keep only digits for the shadow email
  // so it matches firebase-otp-login's `phone.replace(/\D/g,'')@dev.local`.
  const phone = (body.phone ?? '').trim()
  const digits = phone.replace(/\D/g, '')
  const type = body.type === 'dealer' ? 'dealer' : 'customer'

  if (!full_name) return json({ error: 'Enter a name.' }, 400)
  if (!/^\+\d{10,15}$/.test(phone) || digits.length < 10) {
    return json({ error: 'Enter a valid mobile number.' }, 400)
  }

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // --- 3. Refuse duplicates; clean up a legacy login-less profile if present. ---
  // Pre-014 / direct-insert parties have a profile but NO auth user. firebase-
  // otp-login looks parties up by phone with .maybeSingle(), so a duplicate phone
  // would break login — and we can't reuse the old random id. If the stale row
  // has no billing history we replace it; otherwise the shop must migrate it.
  const { data: existing, error: existErr } = await admin
    .from('profiles')
    .select('id, role')
    .eq('phone', phone)
    .maybeSingle()
  if (existErr) return json({ error: existErr.message }, 400)
  if (existing) {
    const { data: stale } = await admin.auth.admin.getUserById(existing.id)
    if (stale?.user) return json({ error: 'This number already has an account.' }, 409)
    // No auth user → legacy login-less row. Try to remove it so we can re-add
    // it properly. A foreign-key error means it already has orders/bills.
    const { error: delErr } = await admin.from('profiles').delete().eq('id', existing.id)
    if (delErr) {
      return json({
        error: 'This number was added before logins were set up and now has ' +
          'billing history. It needs a manual migration — contact support.',
      }, 409)
    }
  }

  // --- 4. Create the login, then re-shape the trigger-made profile. ---
  const shadowEmail = `${digits}@dev.local`
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: shadowEmail,
    email_confirm: true,       // no confirmation email — the shop vouches for them.
    user_metadata: { full_name, phone, role: type },
  })
  if (createErr) {
    const msg = /already.*registered|already.*exists/i.test(createErr.message)
      ? 'This number already has an account.'
      : createErr.message
    return json({ error: msg }, 409)
  }

  const newId = created.user!.id

  // handle_new_user already inserted a profile with id = newId. Bind it to THIS
  // shop as a customer/dealer, and clear the shadow email off the CONTACT field
  // (email on profiles is optional contact info, not the login handle).
  const { data: party, error: shapeErr } = await admin
    .from('profiles')
    .update({
      role: type,
      full_name,
      phone,
      email: null,
      shop_id: caller.shop_id,
      is_active: true,
    })
    .eq('id', newId)
    .select('id, full_name, phone, role')
    .single()
  if (shapeErr) {
    // Roll back so a half-made account can't linger. NOTE: migration 014 dropped
    // the profiles→auth.users FK (login-less counter buyers), so deleting the
    // auth user NO LONGER cascade-removes the trigger-made profile. Delete the
    // profile explicitly FIRST, or it lingers as an un-loginable orphan
    // (has_auth_user=false) that later breaks phone-OTP login.
    await admin.from('profiles').delete().eq('id', newId)
    await admin.auth.admin.deleteUser(newId)
    return json({ error: shapeErr.message }, 400)
  }

  return json({ ok: true, party })
})
