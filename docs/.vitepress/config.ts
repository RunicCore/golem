import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';
import { stageDocsPublicAssets } from '../../scripts/docs-examples.js';
import { buildSupportProjection } from '../../scripts/support-projection.js';
import { readWorkspaceReleaseVersion } from '../../scripts/release-version.js';
import { NAV, SIDEBAR } from './sidebar.js';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const releaseVersion = readWorkspaceReleaseVersion(workspaceRoot);

function docsBase(): string {
  const raw = (process.env.DOCS_BASE ?? '/').trim() || '/';
  const withLead = raw.startsWith('/') ? raw : `/${raw}`;
  return withLead.endsWith('/') ? withLead : `${withLead}/`;
}

function docsOutDir(): string {
  const requested = process.env.DOCS_OUT_DIR;
  return requested ? path.resolve(requested) : path.join(workspaceRoot, 'docs/.vitepress/dist');
}

export default defineConfig({
  lang: 'en-US',
  title: 'ExprtLabs Golem',
  description: 'TypeScript models, validation and serialization, with OpenAPI clients and optional MobX integration.',
  srcDir: '.',
  base: docsBase(),
  outDir: docsOutDir(),
  cacheDir: process.env.DOCS_CACHE_DIR ?? path.join(workspaceRoot, 'docs/.vitepress/cache'),
  ignoreDeadLinks: false,
  lastUpdated: false,
  appearance: 'dark',
  themeConfig: {
    siteTitle: `Golem v${releaseVersion}`,
    outline: [2, 3],
    search: {
      provider: 'local',
    },
    nav: NAV.map(item => ({ ...item })),
    sidebar: SIDEBAR.map(group => ({ text: group.text, items: group.items.map(item => ({ ...item })) })),
    socialLinks: [{ icon: 'github', link: 'https://github.com/exprtlabs/codegen' }],
    footer: {
      message: 'Released under the <a href="https://github.com/exprtlabs/codegen/blob/main/LICENSE">MIT License</a>.',
      copyright: 'Made by <a href="https://exprtlabs.ai">exprtlabs.ai</a>',
    },
  },
  vite: {
    // Only this consumer projection enters the browser bundle. The source
    // registry also contains evidence and workspace paths and stays server-side.
    define: {
      __EXPRTLABS_SUPPORT_PROJECTION__: JSON.stringify(buildSupportProjection()),
    },
    publicDir: stageDocsPublicAssets(workspaceRoot),
    build: {
      sourcemap: false,
    },
    server: {
      fs: {
        allow: [workspaceRoot],
      },
    },
  },
});
