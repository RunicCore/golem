import type { ClientRuntime, RuntimeSecuritySchemes } from './core.js';
import { appendQuery } from './parameters.js';

export interface AuthContext {
  readonly scheme: string;
  readonly type: string;
  readonly scopes: readonly string[];
  readonly flows?: Readonly<Record<string, unknown>>;
  readonly openIdConnectUrl?: string;
}

export type TokenAuthValue<Context extends AuthContext = AuthContext> =
  | string
  | ((context: Context) => string | Promise<string>);

export type BasicCredentials = { username: string; password: string };
export type BasicAuthValue<Context extends AuthContext = AuthContext> =
  | BasicCredentials
  | ((context: Context) => BasicCredentials | Promise<BasicCredentials>);

type ResolvedAuthValue = string | BasicCredentials;

async function authValue(
  runtime: ClientRuntime,
  name: string,
  scopes: readonly string[],
  securitySchemes: RuntimeSecuritySchemes,
): Promise<ResolvedAuthValue | undefined> {
  if (securitySchemes[name]?.type === 'mutualTLS') {
    return runtime.options.mutualTls ? 'mutualTLS' : undefined;
  }
  const definition = securitySchemes[name];
  const auth = runtime.options.auth;
  if (!auth || !Object.hasOwn(auth, name)) return undefined;
  const configured: unknown = Reflect.get(auth, name);
  const resolved: unknown = typeof configured === 'function'
    ? await configured({
      scheme: name,
      type: definition?.type || 'unresolved',
      scopes,
      flows: definition?.flows,
      openIdConnectUrl: definition?.openIdConnectUrl,
    })
    : configured;
  if (resolved === undefined) return undefined;
  if (typeof resolved === 'string') return resolved;
  if (typeof resolved === 'object' && resolved !== null) {
    const username = Reflect.get(resolved, 'username');
    const password = Reflect.get(resolved, 'password');
    if (typeof username === 'string' && typeof password === 'string') {
      return { username, password };
    }
  }
  throw new TypeError(`Authentication provider for ${name} returned an invalid value`);
}

/** RFC 7617 with UTF-8: btoa alone accepts only Latin-1. */
function basicCredentials(username: string, password: string): string {
  if (username.includes(':')) throw new TypeError('A Basic authentication username must not contain ":" (RFC 7617).');
  let binary = '';
  for (const byte of new TextEncoder().encode(`${username}:${password}`)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function applyAuthScheme(
  runtime: ClientRuntime,
  name: string,
  value: ResolvedAuthValue | undefined,
  query: string[],
  headers: Headers,
  cookies: string[],
  securitySchemes: RuntimeSecuritySchemes,
): void {
  if (value === undefined) return;
  const scheme = securitySchemes[name];
  if (!scheme) throw new Error(`Unknown OpenAPI security scheme: ${name}`);
  if (scheme.type === 'mutualTLS') return;
  const text = typeof value === 'string' ? value : basicCredentials(value.username, value.password);
  if (scheme.type === 'apiKey' && scheme.in === 'query') appendQuery(runtime, query, scheme.name || name, text, false);
  else if (scheme.type === 'apiKey' && scheme.in === 'cookie') cookies.push(`${scheme.name || name}=${encodeURIComponent(text)}`);
  else if (scheme.type === 'apiKey') headers.set(scheme.name || name, text);
  else if (scheme.type === 'http' && scheme.scheme?.toLowerCase() === 'basic') headers.set('Authorization', `Basic ${text}`);
  else if (scheme.type === 'http' && scheme.scheme?.toLowerCase() === 'bearer') headers.set('Authorization', `Bearer ${text}`);
  else if (scheme.type === 'oauth2' || scheme.type === 'openIdConnect') headers.set('Authorization', `Bearer ${text}`);
  else if (scheme.type === 'http') {
    throw new Error(`Unsupported HTTP authentication scheme: ${scheme.scheme}`);
  }
  else throw new Error(`Unsupported OpenAPI security scheme type: ${scheme.type}`);
}

export async function applySecurity(
  runtime: ClientRuntime,
  requirements: Array<Record<string, string[]>>,
  query: string[],
  headers: Headers,
  cookies: string[],
  securitySchemes: RuntimeSecuritySchemes,
): Promise<void> {
  if (!requirements.length) return;
  // An empty requirement ({}) makes authentication optional: it is the
  // fallback after every requirement that configured credentials satisfy.
  for (const requirement of requirements) {
    if (Object.keys(requirement).length === 0) continue;
    const values = await Promise.all(Object.entries(requirement)
      .map(async ([name, scopes]) => [name, await authValue(runtime, name, scopes, securitySchemes)] as const));
    if (values.every(([, value]) => value !== undefined)) {
      for (const [name, value] of values) applyAuthScheme(runtime, name, value, query, headers, cookies, securitySchemes);
      return;
    }
  }
  if (requirements.some((requirement) => Object.keys(requirement).length === 0)) return;
  throw new Error('No configured credentials satisfy the operation security requirements');
}
