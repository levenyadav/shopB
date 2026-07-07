// firebase-otp-login — bridge Firebase Phone Auth → a real Supabase session.
//
// Why this exists: Firebase Phone Auth sends the SMS and proves phone ownership,
// but the app's identity is Supabase Auth (every RLS policy / trigger keys off
// auth.uid()). A Firebase token means nothing to Postgres. This function:
//   1. verifies the Firebase ID token against Google's PUBLIC keys (no Firebase
//      service account needed — verification is asymmetric),
//   2. reads the VERIFIED phone number from the token,
//   3. finds the party's EXISTING profile by that phone (never creates one —
//      accounts are provisioned by the shop, per SPEC; unknown/inactive → 403),
//   4. ensures a shadow email on their auth user (reusing the <digits>@dev.local
//      convention) so we can mint a session, then generateLink → one-time
//      token_hash the browser redeems with supabase.auth.verifyOtp().
//
// Deploy (public — the caller has no Supabase session yet, so skip JWT gate):
//   supabase functions deploy firebase-otp-login --no-verify-jwt
//   supabase secrets set FIREBASE_PROJECT_ID=your-firebase-project-id
// (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { createRemoteJWKSet, jwtVerify } from 'https://esm.sh/jose@5'

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

// Google publishes the public keys that sign Firebase ID tokens here. jose
// caches the JWKS and rotates automatically.
const JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const projectId = Deno.env.get('FIREBASE_PROJECT_ID')
  if (!projectId) return json({ error: 'Server not configured (FIREBASE_PROJECT_ID).' }, 500)

  // --- 1. Read + verify the Firebase ID token. ---
  let body: { idToken?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid request body.' }, 400)
  }
  const idToken = (body.idToken ?? '').trim()
  if (!idToken) return json({ error: 'Missing Firebase token.' }, 400)

  let phone: string
  try {
    // Firebase ID tokens: RS256, iss=securetoken.google.com/<projectId>,
    // aud=<projectId>. jose checks signature + iss + aud + exp for us.
    const { payload } = await jwtVerify(idToken, JWKS, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    })
    // Firebase puts the verified E.164 number in phone_number for phone auth.
    phone = String(payload.phone_number ?? '').trim()
    if (!phone) return json({ error: 'This sign-in has no verified phone number.' }, 400)
  } catch (_e) {
    return json({ error: 'Could not verify this sign-in. Please try again.' }, 401)
  }

  // --- 2. Find the EXISTING party for this phone. Never self-provision. ---
  const url = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data: profile, error: profErr } = await admin
    .from('profiles')
    .select('id, is_active')
    .eq('phone', phone)
    .maybeSingle()
  if (profErr) return json({ error: profErr.message }, 400)
  if (!profile) return json({ error: 'No account for this number. Ask the shop to add you.' }, 403)
  if (profile.is_active === false) return json({ error: 'This account is disabled. Contact the shop.' }, 403)

  // --- 3. Ensure a shadow email so we can mint a session, then generate a link. ---
  const shadowEmail = `${phone.replace(/\D/g, '')}@dev.local`
  const { data: userRes, error: getErr } = await admin.auth.admin.getUserById(profile.id)
  if (getErr || !userRes?.user) return json({ error: 'Login for this account is not set up.' }, 400)

  if (!userRes.user.email) {
    const { error: updErr } = await admin.auth.admin.updateUserById(profile.id, {
      email: shadowEmail,
      email_confirm: true,
    })
    if (updErr) return json({ error: updErr.message }, 400)
  }
  const email = userRes.user.email ?? shadowEmail

  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  })
  if (linkErr || !link?.properties?.hashed_token) {
    return json({ error: linkErr?.message ?? 'Could not create a session.' }, 400)
  }

  // The browser redeems this with supabase.auth.verifyOtp({ token_hash, type:'email' }).
  return json({ token_hash: link.properties.hashed_token })
})
