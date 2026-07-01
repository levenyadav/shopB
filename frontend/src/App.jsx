import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import OwnerLayout from './components/OwnerLayout'
import StaffLayout from './components/StaffLayout'
import ShopLayout from './components/ShopLayout'
import Login from './pages/public/Login'
import Shopfront from './pages/public/Shopfront'
import ItemDetail from './pages/public/ItemDetail'
import Cart from './pages/public/Cart'
import ContentPage from './pages/public/ContentPage'
import MyOrders from './pages/customer/MyOrders'
import MyOrderDetail from './pages/customer/MyOrderDetail'
import MyAccount from './pages/customer/MyAccount'
import Dashboard from './pages/owner/Dashboard'
import PurchaseEntry from './pages/owner/PurchaseEntry'
import BulkPurchase from './pages/owner/BulkPurchase'
import Inventory from './pages/owner/Inventory'
import StockInquiry from './pages/owner/StockInquiry'
import OrderManagement from './pages/owner/OrderManagement'
import OrderDetail from './pages/owner/OrderDetail'
import PaymentEntry from './pages/owner/PaymentEntry'
import Parties from './pages/owner/Parties'
import PartyDetail from './pages/owner/PartyDetail'
import Fulfilment from './pages/shared/Fulfilment'
import FulfilmentDetail from './pages/shared/FulfilmentDetail'
import Reports from './pages/owner/Reports'
import Settings from './pages/owner/Settings'
import Sales from './pages/owner/Sales'
import SaleDetail from './pages/owner/SaleDetail'
import CounterSale from './pages/shared/CounterSale'

// Guards buyer-only routes (My Orders / Account). Browsing is public; these
// require a customer/dealer login. Owner is sent to the console, others home.
function BuyerOnly({ children }) {
  const { session, role, loading } = useAuth()
  if (loading) return null
  if (!session) return <Navigate to="/login" replace />
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
  const { session, loading } = useAuth()
  return (
    <Routes>
      <Route
        path="/login"
        element={loading ? null : session ? <Navigate to="/" replace /> : <Login />}
      />

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
        <Route path="bulk-purchase" element={<BulkPurchase />} />
        <Route path="inventory" element={<Inventory />} />
        <Route path="stock" element={<StockInquiry />} />
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
        <Route path="fulfil/:id" element={<FulfilmentDetail listPath="/staff" />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
