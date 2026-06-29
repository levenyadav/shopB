import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import OwnerLayout from './components/OwnerLayout'
import Login from './pages/public/Login'
import Home from './pages/Home'
import Dashboard from './pages/owner/Dashboard'
import PurchaseEntry from './pages/owner/PurchaseEntry'
import Inventory from './pages/owner/Inventory'
import ComingSoon from './pages/owner/ComingSoon'

// Sends the owner to their console; everyone else gets the Phase-1 placeholder
// home for now (customer/staff screens arrive in later phases).
function RoleLanding() {
  const { role } = useAuth()
  if (role === 'owner') return <Navigate to="/owner" replace />
  return <Home />
}

// Guards the owner console. Non-owners are bounced to their landing.
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

      <Route
        path="/"
        element={
          <ProtectedRoute>
            <RoleLanding />
          </ProtectedRoute>
        }
      />

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
        <Route path="stock" element={<ComingSoon title="Stock Inquiry" phase="Phase 2 polish" />} />
        <Route path="orders" element={<ComingSoon title="Orders" phase="Phase 3" />} />
        <Route path="sales" element={<ComingSoon title="Sales" phase="Phase 3" />} />
        <Route path="payments" element={<ComingSoon title="Payments" phase="Phase 5" />} />
        <Route path="parties" element={<ComingSoon title="Parties" phase="Phase 3" />} />
        <Route path="reports" element={<ComingSoon title="Reports" phase="Phase 6" />} />
        <Route path="settings" element={<ComingSoon title="Settings" phase="Phase 6" />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
