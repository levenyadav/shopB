import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import OwnerLayout from './components/OwnerLayout'
import ShopLayout from './components/ShopLayout'
import Login from './pages/public/Login'
import Shopfront from './pages/public/Shopfront'
import ItemDetail from './pages/public/ItemDetail'
import MyOrders from './pages/customer/MyOrders'
import MyOrderDetail from './pages/customer/MyOrderDetail'
import MyAccount from './pages/customer/MyAccount'
import Dashboard from './pages/owner/Dashboard'
import PurchaseEntry from './pages/owner/PurchaseEntry'
import Inventory from './pages/owner/Inventory'
import StockInquiry from './pages/owner/StockInquiry'
import OrderManagement from './pages/owner/OrderManagement'
import OrderDetail from './pages/owner/OrderDetail'
import ComingSoon from './pages/owner/ComingSoon'

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
        <Route path="inventory" element={<Inventory />} />
        <Route path="stock" element={<StockInquiry />} />
        <Route path="orders" element={<OrderManagement />} />
        <Route path="orders/:id" element={<OrderDetail />} />
        <Route path="sales" element={<ComingSoon title="Sales" phase="Phase 3" />} />
        <Route path="payments" element={<ComingSoon title="Payments" phase="Phase 5" />} />
        <Route path="parties" element={<ComingSoon title="Parties" phase="Phase 5" />} />
        <Route path="reports" element={<ComingSoon title="Reports" phase="Phase 6" />} />
        <Route path="settings" element={<ComingSoon title="Settings" phase="Phase 6" />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
