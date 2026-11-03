export const routePrefix = 'items' as const;
export function routeFor(name: string): string { return routePrefix + '/' + name; }
