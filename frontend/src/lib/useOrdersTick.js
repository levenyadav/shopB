import { useEffect, useState } from 'react'
import { supabase } from './supabase'

// A number that goes up whenever the buyer's orders may have changed. Put it in
// a load effect's deps so the screen re-reads instead of showing the status it
// had when first opened.
//
// Why: phones keep a tab (or the installed app) alive for days. The buyer's
// order screens loaded once and never again, so an order the shop rejected on
// 28 Sept still read "Awaiting confirmation" on the buyer's phone a day later.
//
// Bumps on:
//   * any change to `orders` over Supabase Realtime — RLS (orders_buyer_select)
//     means a buyer only receives their own rows;
//   * the tab becoming visible again / the page restored from the back-forward
//     cache — covers a dropped realtime socket while the phone was asleep.
export function useOrdersTick() {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const bump = () => setTick((t) => t + 1)
    const onVisible = () => { if (document.visibilityState === 'visible') bump() }
    const onPageShow = (e) => { if (e.persisted) bump() }

    const channel = supabase
      .channel(`buyer-orders-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, bump)
      .subscribe()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      supabase.removeChannel(channel)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [])

  return tick
}
