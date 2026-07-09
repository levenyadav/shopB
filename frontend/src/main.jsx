import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { ShopProvider } from './context/ShopContext'
import { CartProvider } from './context/CartContext'
import './index.css'
import App from './App.jsx'
import { registerServiceWorker } from './lib/pwa'

// Register the PWA service worker so the app can be installed and opened offline.
registerServiceWorker()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ShopProvider>
          <CartProvider>
            <App />
          </CartProvider>
        </ShopProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
