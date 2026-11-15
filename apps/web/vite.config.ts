import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/** The SPA is served by the Fastify server at `/` with the API at `/api/*`; in dev, proxy to it. */
const API_ORIGIN = process.env['PIALY_API_ORIGIN'] ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { '/api': API_ORIGIN } },
  test: {
    name: '@pialy/web',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
