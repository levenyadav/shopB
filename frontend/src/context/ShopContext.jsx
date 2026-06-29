import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from './AuthContext'

// Shop-wide reference data shared across owner/staff screens: the shop record,
// its categories and its suppliers. Loaded once per session and refreshed after
// inline creates (e.g. a new supplier from Purchase Entry). RLS scopes the rows.
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
      .select('id, name, address, phone, currency_symbol')
      .order('created_at')
      .limit(1)
      .maybeSingle()
    setShop(data ?? null)
  }, [])

  useEffect(() => {
    if (!session) {
      setShop(null); setCategories([]); setSuppliers([]); setLoading(false)
      return
    }
    let active = true
    setLoading(true)
    Promise.all([loadShop(), loadCategories(), loadSuppliers()]).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
    // re-run when the signed-in profile (and thus shop/role) settles
  }, [session, profile?.id, loadShop, loadCategories, loadSuppliers])

  const value = {
    shop,
    shopId: profile?.shop_id ?? shop?.id ?? null,
    currency: shop?.currency_symbol || '₹',
    categories,
    suppliers,
    loading,
    refreshSuppliers: loadSuppliers,
    refreshCategories: loadCategories,
  }
  return <ShopContext.Provider value={value}>{children}</ShopContext.Provider>
}

export function useShop() {
  const ctx = useContext(ShopContext)
  if (!ctx) throw new Error('useShop must be used within ShopProvider')
  return ctx
}
