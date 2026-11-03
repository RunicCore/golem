
declare module '@nestjs/swagger' {
  export function ApiWidgetResponse(options?: { description?: string }): MethodDecorator & ClassDecorator;
}
export {};
