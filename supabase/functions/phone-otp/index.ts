// phone-otp — send + verify login OTPs via Fast2SMS, then mint a Supabase session.
//
// Fast2SMS only DELIVERS the SMS; it does not generate or verify codes. So this
// function owns the whole OTP lifecycle:
//   send   — find the party's EXISTING profile by phone (never self-provision),
//            generate a 6-digit code, store only its hash in `phone_otps`, and
//            text it via Fast2SMS's Quick SMS (`q`) route (no DLT / verification).
//   verify — check the stored hash (expiry + attempt-capped), then reuse the
//            admin generateLink → token_hash trick so the browser can redeem a
//            real Supabase session with supabase.auth.verifyOtp(). Identity stays
//            Supabase Auth; every RLS policy keys off auth.uid().
//
// Deploy (public — the caller has no Supabase session yet, so skip the JWT gate):
//   supabase functions deploy phone-otp --no-verify-jwt
//   supabase secrets set FAST2SMS_API_KEY=your-fast2sms-api-key
// (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.)

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

const OTP_TTL_MS = 5 * 60 * 1000   // codes expire 5 minutes after sending
const MAX_ATTEMPTS = 5             // wrong guesses before the code is burned

// SHA-256 of "<phone>:<code>" — the code itself is never stored or logged.
async function hashCode(phone: string, code: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${phone}:${code}`)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let body: { action?: string; phone?: string; code?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid request body.' }, 400)
  }

  // Phone arrives already normalised to E.164 (+91XXXXXXXXXX) from the client.
  const phone = (body.phone ?? '').trim()
  if (!/^\+91[6-9]\d{9}$/.test(phone)) return json({ error: 'Enter a valid 10-digit mobile number.' }, 400)

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )

  if (body.action === 'send') return handleSend(admin, phone)
  if (body.action === 'verify') return handleVerify(admin, phone, (body.code ?? '').trim())
  return json({ error: 'Unknown action.' }, 400)
})

// deno-lint-ignore no-explicit-any
async function handleSend(admin: any, phone: string) {
  // Only send to a KNOWN, active party. Never self-provision — accounts are
  // created by the shop (per SPEC). Unknown/inactive → same 403 as before.
  const { data: profile, error: profErr } = await admin
    .from('profiles').select('id, is_active').eq('phone', phone).maybeSingle()
  if (profErr) return json({ error: profErr.message }, 400)
  if (!profile) return json({ error: 'No account for this number. Ask the shop to add you.' }, 403)
  if (profile.is_active === false) return json({ error: 'This account is disabled. Contact the shop.' }, 403)

  const code = String(Math.floor(100000 + Math.random() * 900000))   // 6 digits, no leading zero
  const { error: upErr } = await admin.from('phone_otps').upsert({
    phone,
    code_hash: await hashCode(phone, code),
    expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
    attempts: 0,
  })
  if (upErr) return json({ error: upErr.message }, 400)

  // Fast2SMS Quick SMS route (`q`): we compose the text ourselves. The built-in
  // `otp` route needs Fast2SMS "website verification" (status 996) which this
  // account doesn't have, so `q` is the no-DLT path that works today.
  const apiKey = Deno.env.get('FAST2SMS_API_KEY')
  if (!apiKey) return json({ error: 'Server not configured (FAST2SMS_API_KEY).' }, 500)
  const smsRes = await fetch('https://www.fast2sms.com/dev/bulkV2', {
    method: 'POST',
    headers: { authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      route: 'q',
      message: `${code} is your login code.`,
      language: 'english',
      flash: 0,
      numbers: phone.slice(-10),   // Fast2SMS wants the bare 10-digit number
    }),
  })
  const smsBody = await smsRes.json().catch(() => ({}))
  if (!smsRes.ok || smsBody?.return !== true) {
    return json({ error: 'Could not send the code right now. Please try again.' }, 502)
  }
  return json({ ok: true })
}

// deno-lint-ignore no-explicit-any
async function handleVerify(admin: any, phone: string, code: string) {
  if (!/^\d{6}$/.test(code)) return json({ error: 'Enter the 6-digit code from the SMS.' }, 400)

  const { data: row, error: rowErr } = await admin
    .from('phone_otps').select('code_hash, expires_at, attempts').eq('phone', phone).maybeSingle()
  if (rowErr) return json({ error: rowErr.message }, 400)
  if (!row || new Date(row.expires_at).getTime() < Date.now()) {
    return json({ error: 'That code is wrong or expired. Request a new one.' }, 401)
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    await admin.from('phone_otps').delete().eq('phone', phone)
    return json({ error: 'Too many attempts. Request a new code.' }, 429)
  }
  if (row.code_hash !== await hashCode(phone, code)) {
    await admin.from('phone_otps').update({ attempts: row.attempts + 1 }).eq('phone', phone)
    return json({ error: 'That code is wrong or expired. Request a new one.' }, 401)
  }

  // Correct code — burn it so it can't be replayed.
  await admin.from('phone_otps').delete().eq('phone', phone)

  // Mint a real Supabase session. Same bridge the Firebase path used: ensure a
  // shadow email on the auth user, then generateLink → one-time token_hash that
  // the browser redeems with supabase.auth.verifyOtp({ token_hash, type:'email' }).
  const { data: profile } = await admin
    .from('profiles').select('id, is_active').eq('phone', phone).maybeSingle()
  if (!profile) return json({ error: 'No account for this number. Ask the shop to add you.' }, 403)
  if (profile.is_active === false) return json({ error: 'This account is disabled. Contact the shop.' }, 403)

  const { data: userRes, error: getErr } = await admin.auth.admin.getUserById(profile.id)
  if (getErr || !userRes?.user) return json({ error: 'Login for this account is not set up.' }, 400)

  const shadowEmail = `${phone.replace(/\D/g, '')}@dev.local`
  if (!userRes.user.email) {
    const { error: updErr } = await admin.auth.admin.updateUserById(profile.id, {
      email: shadowEmail, email_confirm: true,
    })
    if (updErr) return json({ error: updErr.message }, 400)
  }
  const email = userRes.user.email ?? shadowEmail

  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'magiclink', email,
  })
  if (linkErr || !link?.properties?.hashed_token) {
    return json({ error: linkErr?.message ?? 'Could not create a session.' }, 400)
  }
  return json({ token_hash: link.properties.hashed_token })
}
