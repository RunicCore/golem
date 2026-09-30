export const routes = {
  // A plain function, not a Nest provider: the OpenAPI generator evaluates it
  // at generate time and `@Controller` calls it again at runtime.
  resource(
    { service, resource }: { service: string; resource: string },
  ): string {
    return `${service}/${resource}`;
  },
};
