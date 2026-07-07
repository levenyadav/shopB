// Firebase — used ONLY as the SMS/phone-verification layer for login.
//
// Firebase Phone Auth sends the SMS and verifies the 6-digit code, giving us a
// signed Firebase ID token that PROVES the user controls the phone number. That
// token is NOT our session: the app's identity is Supabase Auth (all RLS keys
// off auth.uid()). We hand the token to the `firebase-otp-login` Edge Function,
// which verifies it server-side and mints a real Supabase session. After login,
// Firebase is invisible — see pages/public/Login.jsx.
//
// Config is public by design (Firebase web keys are not secrets; access is
// gated by Firebase's authorized-domains + our Edge Function). Fill the
// VITE_FIREBASE_* vars in .env. When VITE_FIREBASE_API_KEY is absent, the login
// screen falls back to the existing dev/native OTP path and this module's auth
// getter throws only if actually used.
import { initializeApp, getApps, getApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'

export const firebaseEnabled = !!import.meta.env.VITE_FIREBASE_API_KEY

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

// Lazily initialise so importing this module is cheap and safe even when
// Firebase isn't configured (dev/native OTP path never touches getFirebaseAuth).
export function getFirebaseAuth() {
  if (!firebaseEnabled) {
    throw new Error('Firebase is not configured (VITE_FIREBASE_API_KEY missing).')
  }
  const app = getApps().length ? getApp() : initializeApp(firebaseConfig)
  return getAuth(app)
}
