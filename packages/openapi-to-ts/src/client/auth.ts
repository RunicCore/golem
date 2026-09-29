import type { EmissionPlan } from '../emission-plan.js';

export function emitAuthMethods(clientName: string, plan?: EmissionPlan): string {
  const mutualTls = plan?.clientSurfaces.mutualTls ?? true;
  return `
  private async authValue(
    name: string,
    scopes: readonly string[],
    securitySchemes: RuntimeSecuritySchemes,
  ): Promise<${clientName}ResolvedAuthValue | undefined> {
${mutualTls ? `    if (securitySchemes[name]?.type === 'mutualTLS') {
      return this.mutualTls ? 'mutualTLS' : undefined;
    }` : ''}
    const definition = securitySchemes[name];
    if (!this.auth || !Object.hasOwn(this.auth, name)) return undefined;
    const configured: unknown = Reflect.get(this.auth, name);
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
    throw new TypeError(\`Authentication provider for \${name} returned an invalid value\`);
  }

  public async applySecurity(
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
        .map(async ([name, scopes]) => [name, await this.authValue(name, scopes, securitySchemes)] as const));
      if (values.every(([, value]) => value !== undefined)) {
        for (const [name, value] of values) this.applyAuthScheme(name, value, query, headers, cookies, securitySchemes);
        return;
      }
    }
    if (requirements.some((requirement) => Object.keys(requirement).length === 0)) return;
    throw new Error('No configured credentials satisfy the operation security requirements');
  }

  /** RFC 7617 with UTF-8: btoa alone accepts only Latin-1. */
  private basicCredentials(username: string, password: string): string {
    if (username.includes(':')) throw new TypeError('A Basic authentication username must not contain ":" (RFC 7617).');
    let binary = '';
    for (const byte of new TextEncoder().encode(\`\${username}:\${password}\`)) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  private applyAuthScheme(
    name: string,
    value: ${clientName}ResolvedAuthValue | undefined,
    query: string[],
    headers: Headers,
    cookies: string[],
    securitySchemes: RuntimeSecuritySchemes,
  ): void {
    if (value === undefined) return;
    const scheme = securitySchemes[name];
    if (!scheme) throw new Error(\`Unknown OpenAPI security scheme: \${name}\`);
    if (scheme.type === 'mutualTLS') return;
    const text = typeof value === 'string' ? value : this.basicCredentials(value.username, value.password);
    if (scheme.type === 'apiKey' && scheme.in === 'query') this.appendQuery(query, scheme.name || name, text, false);
    else if (scheme.type === 'apiKey' && scheme.in === 'cookie') cookies.push(\`\${scheme.name || name}=\${encodeURIComponent(text)}\`);
    else if (scheme.type === 'apiKey') headers.set(scheme.name || name, text);
    else if (scheme.type === 'http' && scheme.scheme?.toLowerCase() === 'basic') headers.set('Authorization', \`Basic \${text}\`);
    else if (scheme.type === 'http' && scheme.scheme?.toLowerCase() === 'bearer') headers.set('Authorization', \`Bearer \${text}\`);
    else if (scheme.type === 'oauth2' || scheme.type === 'openIdConnect') headers.set('Authorization', \`Bearer \${text}\`);
    else if (scheme.type === 'http') {
      throw new Error(\`Unsupported HTTP authentication scheme: \${scheme.scheme}\`);
    }
    else throw new Error(\`Unsupported OpenAPI security scheme type: \${scheme.type}\`);
  }
`;
}
