import { defineConfig } from 'vite';
// #region vite-config
import react from '@vitejs/plugin-react';
import { golem } from '@exprtlabs/golem/vite';

const plugins = [golem({ config: 'web/golem.yaml' }), react()];
// #endregion vite-config

export default defineConfig({
  plugins,
  server: {
    port: 5173,
    strictPort: true,
    // The editor calls the API on its own origin, so localhost and 127.0.0.1 both work.
    proxy: { '/api': `http://127.0.0.1:${process.env.API_PORT ?? '3000'}` },
  },
});
