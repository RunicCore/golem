export function resourcePath(options: { service: string; resource: string }): string {
  return `/${options.service}/${options.resource}`;
}
