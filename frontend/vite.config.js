import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// envDir '..' so the app reads the single root .env (VITE_SUPABASE_* live there).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  envDir: '..',
  server: {
    // Allow Cloudflare quick tunnels (random *.trycloudflare.com subdomain each run).
    // Leading dot whitelists the domain and all its subdomains.
    allowedHosts: ['.trycloudflare.com'],
  },
})
