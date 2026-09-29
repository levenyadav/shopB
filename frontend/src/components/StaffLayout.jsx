import {
  IconClipboardCheck, IconCashRegister, IconBoxSeam, IconClipboardList,
} from '@tabler/icons-react'
import ConsoleShell from './ConsoleShell'

// SPEC §10.3 — Staff console. Two jobs: pack the fulfilment board, and ring up
// walk-ins at the counter (POS, SPEC §6.5a). Same shell as the owner console
// (ConsoleShell) so the two consoles feel like one register.
const NAV = [
  { to: '/staff', end: true, label: 'Fulfilment', short: 'Pack', icon: IconClipboardCheck },
  { to: '/staff/counter-sale', label: 'New Sale', icon: IconCashRegister },
  { to: '/staff/inventory', label: 'Inventory', icon: IconBoxSeam },
  { to: '/staff/stock', label: 'Stock', icon: IconClipboardList },
]

const TITLES = {
  '/staff': 'Fulfilment',
  '/staff/counter-sale': 'New Sale',
  '/staff/inventory': 'Inventory',
  '/staff/stock': 'Stock',
}

export default function StaffLayout() {
  // Four screens — all fit the phone tab bar, so staff never need a menu.
  return <ConsoleShell home="/staff" groups={[{ items: NAV }]} tabs={NAV.map((n) => n.to)} titles={TITLES} />
}
