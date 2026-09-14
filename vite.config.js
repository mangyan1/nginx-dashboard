import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // Follows DASH_PORT: `DASH_PORT=3123 npm start` with `npm run dev` used to proxy /api to
    // whatever else was on 3000, which reads as "the dashboard is broken", not "wrong port".
    proxy: { '/api': `http://127.0.0.1:${process.env.DASH_PORT || 7412}` }
  },
  build: { outDir: 'dist' }
})