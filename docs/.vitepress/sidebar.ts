export interface NavItem { readonly text: string; readonly link: string }
export interface SidebarGroup { readonly text: string; readonly items: readonly NavItem[] }

export const SIDEBAR: readonly SidebarGroup[] = [
  { text: 'Introduction', items: [
    { text: 'What is Codegen', link: '/guide/' },
    { text: 'Installation', link: '/guide/install' },
    { text: 'Quick start', link: '/guide/quick-start' },
  ] },
  { text: 'Models', items: [
    { text: 'Defining models', link: '/guide/models' },
    { text: 'Type tags', link: '/guide/tags' },
    { text: 'Validation', link: '/guide/validation' },
    { text: 'Serialization', link: '/guide/serialization' },
    { text: 'Composing models', link: '/guide/model-composition' },
  ] },
  { text: 'API clients', items: [
    { text: 'Generate a client', link: '/guide/client' },
    { text: 'Using the client', link: '/guide/client-usage' },
    { text: 'Models with a client', link: '/guide/models-and-client' },
    { text: 'Authentication', link: '/guide/auth' },
    { text: 'Body codecs', link: '/guide/codecs' },
    { text: 'Streaming responses', link: '/guide/streams' },
  ] },
  { text: 'NestJS', items: [
    { text: 'Generate OpenAPI', link: '/guide/nestjs' },
    { text: 'Controllers in depth', link: '/guide/nestjs-in-depth' },
  ] },
  { text: 'Integrations', items: [
    { text: 'MobX and React', link: '/guide/mobx' },
  ] },
  { text: 'Workflow', items: [
    { text: 'Generate, watch and check', link: '/guide/watch' },
  ] },
  { text: 'Reference', items: [
    { text: 'Configuration', link: '/reference/config' },
    { text: 'CLI', link: '/reference/cli' },
    { text: 'Runtime API', link: '/reference/runtime-api' },
    { text: 'Generator API', link: '/reference/generator-api' },
    { text: 'OpenAPI client support', link: '/reference/openapi-support' },
    { text: 'Diagnostics', link: '/reference/diagnostics' },
  ] },
  { text: 'Project', items: [
    { text: 'Compatibility and stability', link: '/compatibility' },
    { text: 'Release notes', link: '/changelog' },
    { text: 'Benchmarks', link: '/benchmarks' },
  ] },
];

export const NAV: readonly NavItem[] = [
  { text: 'Guide', link: '/guide/' },
  { text: 'Reference', link: '/reference/config' },
  { text: 'Benchmarks', link: '/benchmarks' },
  { text: 'Release notes', link: '/changelog' },
];

export const PAGE_LINKS: readonly string[] = ['/', ...SIDEBAR.flatMap(g => g.items.map(i => i.link))];
