import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  define: { __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.1.0') },
  server: { port: 5173, strictPort: true, fs: { allow: ['..'] } },
  build: { target: 'chrome120', sourcemap: false, chunkSizeWarningLimit: 900 },
});
