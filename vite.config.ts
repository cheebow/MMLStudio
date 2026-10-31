import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// For GitHub Pages sub-path deployment set BASE_PATH, e.g. BASE_PATH=/mml-studio/ npm run build
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
  worker: { format: 'es' },
  build: {
    // Initial chunk = React + CodeMirror + engine (~210 kB gzip). spessasynth_lib (~620 kB) is a
    // separate chunk loaded on the first play (DECISIONS D-019).
    chunkSizeWarningLimit: 700,
  },
});
