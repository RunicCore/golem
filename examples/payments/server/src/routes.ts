// #region route-helper
export const routes = {
  // Plain function, not a Nest provider: the OpenAPI generator evaluates it at
  // generate time, and `@Controller` calls it again at runtime for the route.
  resource(
    { service, resource }: { service: string; resource: string },
  ): string {
    return `${service}/${resource}`;
  },
};
// #endregion route-helper
