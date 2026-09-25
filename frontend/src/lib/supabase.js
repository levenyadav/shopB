import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  throw new Error(
    'Missing Supabase env. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in the root .env.',
  )
}

export const supabase = createClient(url, anonKey)

// PostgREST returns at most 1000 rows per request, silently. Any list that can
// outgrow that (items, stock rows, sales) must page through with this.
// `build` returns a fresh query each call; give it a unique final order (e.g.
// .order('id')) so pages never skip or repeat rows.
export async function fetchAll(build, pageSize = 1000) {
  const rows = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1)
    if (error) return { data: null, error }
    rows.push(...(data ?? []))
    if (!data || data.length < pageSize) return { data: rows, error: null }
  }
}
