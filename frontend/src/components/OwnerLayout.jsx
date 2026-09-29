import { useEffect, useState } from 'react'
import {
  IconLayoutDashboard, IconShoppingCartPlus, IconBoxSeam, IconClipboardList,
  IconReceipt2, IconCoin, IconCash, IconUsers, IconChartBar, IconSettings,
  IconPackage, IconCashRegister, IconHistory,
} from '@tabler/icons-react'
import { supabase } from '../lib/supabase'
import { useShop } from '../context/ShopContext'
import ConsoleShell from './ConsoleShell'

// Live count of orders awaiting approval (SPEC §6.4). Seeds from a count query,
// then Supabase Realtime keeps it current: a new order bumps it, any status
// change re-counts (approve/reject removes it from the pending bucket).
function usePendingOrders(shopId) {
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (!shopId) return
    let active = true
    async function recount() {
      const { count: c } = await supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending')
      if (active) setCount(c ?? 0)
    }
    recount()
    const channel = supabase
      .channel('owner-orders')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, recount)
      .subscribe()
    return () => { active = false; supabase.removeChannel(channel) }
  }, [shopId])
  return count
}

// Owner console nav (SPEC §10.4) — few groups, big labels. The shell itself
// (sidebar, phone tab bar) is ConsoleShell, shared with the staff console.
const NAV = [
  {
    group: 'Overview',
    items: [{ to: '/owner', end: true, label: 'Dashboard', short: 'Home', icon: IconLayoutDashboard }],
  },
  {
    group: 'Stock',
    items: [
      { to: '/owner/purchase', label: 'Purchase Entry', icon: IconShoppingCartPlus },
      { to: '/owner/purchases', label: 'Purchase History', icon: IconHistory },
      { to: '/owner/inventory', label: 'Inventory', icon: IconBoxSeam },
      { to: '/owner/stock', label: 'Stock Inquiry', icon: IconClipboardList },
    ],
  },
  {
    group: 'Selling',
    items: [
      { to: '/owner/counter-sale', label: 'Counter Sale', short: 'Sale', icon: IconCashRegister },
      { to: '/owner/orders', label: 'Orders', icon: IconReceipt2, badge: 'pending' },
      { to: '/owner/fulfilment', label: 'Fulfilment', icon: IconPackage },
      { to: '/owner/sales', label: 'Sales', icon: IconCoin },
    ],
  },
  {
    group: 'Money',
    items: [
      { to: '/owner/payments', label: 'Payments', icon: IconCash },
      { to: '/owner/parties', label: 'Parties', icon: IconUsers },
    ],
  },
  {
    group: 'Books',
    items: [
      { to: '/owner/reports', label: 'Reports', icon: IconChartBar },
      { to: '/owner/settings', label: 'Settings', icon: IconSettings },
    ],
  },
]

const TITLES = {
  '/owner': 'Dashboard',
  '/owner/purchase': 'Purchase Entry',
  '/owner/purchases': 'Purchase History',
  '/owner/bulk-purchase': 'Bulk Purchase',
  '/owner/inventory': 'Inventory',
  '/owner/stock': 'Stock Inquiry',
  '/owner/counter-sale': 'Counter Sale',
  '/owner/orders': 'Orders',
  '/owner/fulfilment': 'Fulfilment',
  '/owner/sales': 'Sales',
  '/owner/payments': 'Payments',
  '/owner/parties': 'Parties',
  '/owner/reports': 'Reports',
  '/owner/settings': 'Settings',
}

export default function OwnerLayout() {
  const { shopId } = useShop()
  const pending = usePendingOrders(shopId)
  return (
    <ConsoleShell
      home="/owner"
      groups={NAV}
      // The phone tab bar: what the owner reaches for all day. Everything
      // else sits under More.
      tabs={['/owner', '/owner/orders', '/owner/counter-sale', '/owner/inventory']}
      titles={TITLES}
      badges={{ '/owner/orders': pending }}
    />
  )
}
