import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// envDir '..' so the app reads the single root .env (VITE_SUPABASE_* live there).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  envDir: '..',
})
