import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function ProtectedRoute({ children }) {
  const { session, loading } = useAuth()
  if (loading) {
    return (
      <div className="min-h-screen grid place-items-center text-muted">
        Loading your register…
      </div>
    )
  }
  if (!session) return <Navigate to="/login" replace />
  return children
}
