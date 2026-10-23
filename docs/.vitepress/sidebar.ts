export interface NavItem { readonly text: string; readonly link: string }
export interface SidebarGroup { readonly text: string; readonly items: readonly NavItem[] }

export const SIDEBAR: readonly SidebarGroup[] = [
  { text: 'Get started', items: [
    { text: 'What is Golem', link: '/guide/' },
    { text: 'Quick start', link: '/guide/quick-start' },
    { text: 'Install', link: '/guide/install' },
    { text: 'Build your app', link: '/guide/build' },
    { text: 'Generate, watch and check', link: '/guide/watch' },
  ] },
  { text: 'Models', items: [
    { text: 'Define models', link: '/guide/models' },
    { text: 'Field types', link: '/guide/field-types' },
    { text: 'Validation tags', link: '/guide/tags' },
    { text: 'Validate models', link: '/guide/validation' },
    { text: 'JSON conversion', link: '/guide/serialization' },
    { text: 'Dates and times', link: '/guide/dates' },
    { text: 'Share models between apps', link: '/guide/shared-models' },
    { text: 'MobX and React', link: '/guide/mobx' },
  ] },
  { text: 'API clients', items: [
    { text: 'Generate a client', link: '/guide/client' },
    { text: 'Call operations', link: '/guide/client-usage' },
    { text: 'Authentication', link: '/guide/auth' },
    { text: 'Body formats', link: '/guide/codecs' },
    { text: 'Streaming responses', link: '/guide/streams' },
    { text: 'SDK types in your models', link: '/guide/models-and-client' },
  ] },
  { text: 'NestJS', items: [
    { text: 'OpenAPI from controllers', link: '/guide/nestjs' },
    { text: 'Convert requests', link: '/guide/nestjs-requests' },
  ] },
  { text: 'Extend Golem', items: [
    { text: 'Write a generator', link: '/guide/generators' },
  ] },
  { text: 'Reference', items: [
    { text: 'Configuration', link: '/reference/config' },
    { text: 'CLI', link: '/reference/cli' },
    { text: 'Runtime API', link: '/reference/runtime-api' },
    { text: 'Generator and tool API', link: '/reference/generator-api' },
    { text: 'Generated files', link: '/reference/generated-files' },
    { text: 'OpenAPI support', link: '/reference/openapi-support' },
    { text: 'NestJS controllers', link: '/reference/nestjs' },
    { text: 'Diagnostics', link: '/reference/diagnostics' },
  ] },
  { text: 'Project', items: [
    { text: 'Compatibility', link: '/compatibility' },
    { text: 'Upgrade to 1.0', link: '/migrating' },
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
