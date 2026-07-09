import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { applyBranding } from '../lib/pwa'
import { useAuth } from './AuthContext'

// Shop-wide reference data. The shop record and its categories are readable by
// everyone (RLS: shops_select / categories_read_active) so the public shopfront
// can show the shop name, currency and category tabs without a login. Suppliers
// are owner/staff-only, so they load just for a signed-in session and refresh
// after inline creates (e.g. a new supplier from Purchase Entry).
const ShopContext = createContext(null)

export function ShopProvider({ children }) {
  const { session, profile } = useAuth()
  const [shop, setShop] = useState(null)
  const [categories, setCategories] = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [loading, setLoading] = useState(true)

  const loadCategories = useCallback(async () => {
    const { data } = await supabase
      .from('categories')
      .select('id, name, type, is_active')
      .eq('is_active', true)
      .order('name')
    setCategories(data ?? [])
  }, [])

  const loadSuppliers = useCallback(async () => {
    const { data } = await supabase
      .from('suppliers')
      .select('id, name, contact_person, phone, address, balance_due, is_active')
      .order('name')
    setSuppliers(data ?? [])
  }, [])

  const loadShop = useCallback(async () => {
    const { data } = await supabase
      .from('shops')
      .select('id, name, address, phone, currency_symbol, gstin, gst_rate, logo_url, icon_url, brand_text, theme_color, ' +
        'legal_name, email, pan, state_name, state_code, bank_details, invoice_prefix, ' +
        'banners, whatsapp, instagram, facebook, youtube, map_url, ' +
        'about_us, privacy_policy, terms, contact_info')
      .order('created_at')
      .limit(1)
      .maybeSingle()
    setShop(data ?? null)
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    // shop + categories are public; suppliers only when signed in.
    const jobs = [loadShop(), loadCategories()]
    if (session) jobs.push(loadSuppliers())
    else setSuppliers([])
    Promise.all(jobs).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
    // re-run when the signed-in profile (and thus shop/role) settles
  }, [session, profile?.id, loadShop, loadCategories, loadSuppliers])

  // Reflect the shop's identity into the document + installable PWA: tab title,
  // favicon / apple-touch-icon, the brand accent colour (drives --color-peacock
  // and the mobile browser bar) and the dynamic Web App Manifest.
  useEffect(() => {
    if (shop) applyBranding(shop)
  }, [shop?.icon_url, shop?.name, shop?.brand_text, shop?.theme_color])

  const value = {
    shop,
    shopId: profile?.shop_id ?? shop?.id ?? null,
    currency: shop?.currency_symbol || '₹',
    categories,
    suppliers,
    loading,
    refreshSuppliers: loadSuppliers,
    refreshCategories: loadCategories,
    refreshShop: loadShop,
  }
  return <ShopContext.Provider value={value}>{children}</ShopContext.Provider>
}

export function useShop() {
  const ctx = useContext(ShopContext)
  if (!ctx) throw new Error('useShop must be used within ShopProvider')
  return ctx
}
