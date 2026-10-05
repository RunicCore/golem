import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { golem } from '@exprtlabs/golem/vite';

export default defineConfig({
  plugins: [golem({ config: 'web/golem.yaml' }), react()],
  server: {
    port: 5173,
    strictPort: true,
    // The editor calls the API on its own origin, so localhost and 127.0.0.1 both work.
    proxy: { '/api': `http://127.0.0.1:${process.env.API_PORT ?? '3000'}` },
  },
});
