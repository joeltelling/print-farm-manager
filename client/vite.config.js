import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Vite's default (host unset) binds 127.0.0.1 only, which is unreachable through
    // Docker's port publishing from outside the container. VITE_DOCKER_HOST is set only
    // by docker-compose.yml's `dev` profile service — native dev is unaffected and keeps
    // binding to localhost only.
    host: process.env.VITE_DOCKER_HOST ? true : undefined,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
