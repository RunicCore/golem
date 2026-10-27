export interface NavItem { readonly text: string; readonly link: string }
export interface SidebarGroup { readonly text: string; readonly items: readonly NavItem[] }

export const SIDEBAR: readonly SidebarGroup[] = [
  { text: 'Get started', items: [
    { text: 'What is Golem', link: '/guide/' },
    { text: 'Quick start', link: '/guide/quick-start' },
  ] },
  { text: 'Build', items: [
    { text: 'Build tools', link: '/guide/build' },
    { text: 'Generate and watch', link: '/guide/watch' },
  ] },
  { text: 'Objects and models', items: [
    { text: 'Define models', link: '/guide/models' },
    { text: 'Field types', link: '/guide/field-types' },
    { text: 'SDK types in models', link: '/guide/models-and-client' },
    { text: 'Share models', link: '/guide/shared-models' },
    { text: 'MobX and React', link: '/guide/mobx' },
  ] },
  { text: 'Validation', items: [
    { text: 'Validation tags', link: '/guide/tags' },
    { text: 'Validate models', link: '/guide/validation' },
  ] },
  { text: 'Serialization', items: [
    { text: 'Serialization', link: '/guide/serialization' },
  ] },
  { text: 'TypeScript to OpenAPI', items: [
    { text: 'OpenAPI from controllers', link: '/guide/nestjs' },
    { text: 'NestJS requests', link: '/guide/nestjs-requests' },
    { text: 'NestJS controllers', link: '/reference/nestjs' },
  ] },
  { text: 'OpenAPI to TypeScript SDK', items: [
    { text: 'Generate an SDK', link: '/guide/client' },
    { text: 'Call operations', link: '/guide/client-usage' },
    { text: 'Authentication', link: '/guide/auth' },
    { text: 'Body formats', link: '/guide/codecs' },
    { text: 'OpenAPI support', link: '/reference/openapi-support' },
  ] },
  { text: 'Extend Golem', items: [
    { text: 'Write a generator', link: '/guide/generators' },
    { text: 'Run the generators from code', link: '/guide/generator-api' },
  ] },
  { text: 'Examples', items: [
    { text: 'Add Golem to a NestJS API', link: '/guide/nestjs-endpoint' },
    { text: "Call a partner's API", link: '/guide/partner-client' },
  ] },
  { text: 'Reference', items: [
    { text: 'Configuration', link: '/reference/config' },
    { text: 'CLI', link: '/reference/cli' },
    { text: 'Runtime API', link: '/reference/runtime-api' },
    { text: 'Generator and tool API', link: '/reference/generator-api' },
    { text: 'Generated files', link: '/reference/generated-files' },
    { text: 'Diagnostics', link: '/reference/diagnostics' },
  ] },
  { text: 'Project', items: [
    { text: 'Compatibility', link: '/compatibility' },
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
