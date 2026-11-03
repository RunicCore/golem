export const routePrefix = 'items' as const;
export function routeFor(name: string): string { return routePrefix + '/' + name; }
export const routes = {
  resource({ service, resource }: { service: string; resource: string }): string {
    return `${service}/${resource}`;
  },
};
