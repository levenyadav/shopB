import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate, useSearchParams, useLocation } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import ShopLayout from './components/ShopLayout'
import Login from './pages/public/Login'
import Shopfront from './pages/public/Shopfront'
import ItemDetail from './pages/public/ItemDetail'
import Cart from './pages/public/Cart'
import ContentPage from './pages/public/ContentPage'
import MyOrders from './pages/customer/MyOrders'
import MyOrderDetail from './pages/customer/MyOrderDetail'
import MyAccount from './pages/customer/MyAccount'

// The owner/staff consoles (PDF, spreadsheet, barcode libraries) load only when
// opened, so a buyer's phone downloads just the shop.
const OwnerLayout = lazy(() => import('./components/OwnerLayout'))
const StaffLayout = lazy(() => import('./components/StaffLayout'))
const Dashboard = lazy(() => import('./pages/owner/Dashboard'))
const PurchaseEntry = lazy(() => import('./pages/owner/PurchaseEntry'))
const PurchaseHistory = lazy(() => import('./pages/owner/PurchaseHistory'))
const PurchaseBillDetail = lazy(() => import('./pages/owner/PurchaseBillDetail'))
const BulkPurchase = lazy(() => import('./pages/owner/BulkPurchase'))
const Inventory = lazy(() => import('./pages/owner/Inventory'))
const ItemHistory = lazy(() => import('./pages/owner/ItemHistory'))
const OrderManagement = lazy(() => import('./pages/owner/OrderManagement'))
const OrderDetail = lazy(() => import('./pages/owner/OrderDetail'))
const PaymentEntry = lazy(() => import('./pages/owner/PaymentEntry'))
const Parties = lazy(() => import('./pages/owner/Parties'))
const PartyDetail = lazy(() => import('./pages/owner/PartyDetail'))
const Fulfilment = lazy(() => import('./pages/shared/Fulfilment'))
const FulfilmentDetail = lazy(() => import('./pages/shared/FulfilmentDetail'))
const StaffInventory = lazy(() => import('./pages/shared/StaffInventory'))
const StaffStockInquiry = lazy(() => import('./pages/shared/StaffStockInquiry'))
const Reports = lazy(() => import('./pages/owner/Reports'))
const Settings = lazy(() => import('./pages/owner/Settings'))
const Sales = lazy(() => import('./pages/owner/Sales'))
const SaleDetail = lazy(() => import('./pages/owner/SaleDetail'))
const CounterSale = lazy(() => import('./pages/shared/CounterSale'))

// Where each role belongs after login. Owner/staff get their consoles; buyers
// (customer/dealer) and anyone else land on the public shopfront.
function roleHome(role) {
  if (role === 'owner') return '/owner'
  if (role === 'staff') return '/staff'
  return '/'
}

// /login. Signed out → the form. Signed in → on to where they belong: a buyer
// who started from the cart goes back to it (?next=/cart); owner/staff always
// land on their console. Only same-site paths are honoured for ?next=.
function LoginRoute() {
  const { session, role, loading } = useAuth()
  const [params] = useSearchParams()
  if (loading) return null
  if (!session) return <Login />
  // Session is up but the profile (hence role) may still be loading — wait
  // rather than bounce to '/', so owner/staff land on their console.
  if (!role) return null
  const next = params.get('next') || ''
  const buyer = role === 'customer' || role === 'dealer'
  const safeNext = /^\/(?!\/)/.test(next) ? next : ''
  return <Navigate to={buyer && safeNext ? safeNext : roleHome(role)} replace />
}

// Guards buyer-only routes (My Orders / Account). Browsing is public; these
// require a customer/dealer login. Owner is sent to the console, others home.
function BuyerOnly({ children }) {
  const { session, role, loading } = useAuth()
  const { pathname } = useLocation()
  if (loading) return null
  if (!session) return <Navigate to={`/login?next=${encodeURIComponent(pathname)}`} replace />
  if (role === 'owner') return <Navigate to="/owner" replace />
  if (role !== 'customer' && role !== 'dealer') return <Navigate to="/" replace />
  return children
}

// Guards the owner console. Non-owners are bounced to the shopfront.
function OwnerOnly({ children }) {
  const { role, loading } = useAuth()
  if (loading) return null
  if (role !== 'owner') return <Navigate to="/" replace />
  return children
}

// Guards the staff console (SPEC §10.3). Owner has their own console; everyone
// else (buyers, anon) goes to the shopfront.
function StaffOnly({ children }) {
  const { role, loading } = useAuth()
  if (loading) return null
  if (role === 'owner') return <Navigate to="/owner" replace />
  if (role !== 'staff') return <Navigate to="/" replace />
  return children
}

export default function App() {
  return (
    <Suspense fallback={null}>
    <Routes>
      <Route path="/login" element={<LoginRoute />} />

      {/* Public shopfront + buyer area (SPEC §10.1–§10.2) — no login to browse */}
      <Route element={<ShopLayout />}>
        <Route path="/" element={<Shopfront />} />
        <Route path="/shop/:categoryId" element={<Shopfront />} />
        <Route path="/item/:id" element={<ItemDetail />} />
        <Route path="/cart" element={<Cart />} />
        <Route path="/about" element={<ContentPage column="about_us" title="About Us" />} />
        <Route path="/contact" element={<ContentPage column="contact_info" title="Contact" />} />
        <Route path="/privacy" element={<ContentPage column="privacy_policy" title="Privacy Policy" />} />
        <Route path="/terms" element={<ContentPage column="terms" title="Terms & Conditions" />} />
        <Route path="/orders" element={<BuyerOnly><MyOrders /></BuyerOnly>} />
        <Route path="/orders/:id" element={<BuyerOnly><MyOrderDetail /></BuyerOnly>} />
        <Route path="/account" element={<BuyerOnly><MyAccount /></BuyerOnly>} />
      </Route>

      {/* Owner console (SPEC §10.4) */}
      <Route
        path="/owner"
        element={
          <ProtectedRoute>
            <OwnerOnly>
              <OwnerLayout />
            </OwnerOnly>
          </ProtectedRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="purchase" element={<PurchaseEntry />} />
        <Route path="purchases" element={<PurchaseHistory />} />
        <Route path="purchases/:id" element={<PurchaseBillDetail />} />
        <Route path="bulk-purchase" element={<BulkPurchase />} />
        <Route path="inventory" element={<Inventory />} />
        <Route path="inventory/:id" element={<ItemHistory />} />
        {/* Stock Inquiry was folded into Inventory ("To reorder" + sort). Old
            links and bookmarks land on the same view there. */}
        <Route path="stock" element={<Navigate to="/owner/inventory?low=1&sort=low" replace />} />
        <Route path="counter-sale" element={<CounterSale />} />
        <Route path="orders" element={<OrderManagement />} />
        <Route path="orders/:id" element={<OrderDetail />} />
        <Route path="fulfilment" element={<Fulfilment detailBase="/owner/fulfilment" />} />
        <Route path="fulfilment/:id" element={<FulfilmentDetail listPath="/owner/fulfilment" />} />
        <Route path="sales" element={<Sales />} />
        <Route path="sales/:id" element={<SaleDetail />} />
        <Route path="payments" element={<PaymentEntry />} />
        <Route path="parties" element={<Parties />} />
        <Route path="parties/:type/:id" element={<PartyDetail />} />
        <Route path="reports" element={<Reports />} />
        <Route path="settings" element={<Settings />} />
      </Route>

      {/* Staff console (SPEC §10.3) — single-purpose: the fulfilment board */}
      <Route
        path="/staff"
        element={
          <ProtectedRoute>
            <StaffOnly>
              <StaffLayout />
            </StaffOnly>
          </ProtectedRoute>
        }
      >
        <Route index element={<Fulfilment detailBase="/staff/fulfil" />} />
        <Route path="counter-sale" element={<CounterSale />} />
        <Route path="inventory" element={<StaffInventory />} />
        <Route path="stock" element={<StaffStockInquiry />} />
        <Route path="fulfil/:id" element={<FulfilmentDetail listPath="/staff" />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
  )
}
