export const routes = {
  prefix(): string { return "/api"; },
  item(id: string): string { return `${this.prefix()}/items/${id}`; },
  objectBoom(): never { throw new Error("object-boom"); },
};
export class Urls {
  static prefix(): string { return "/urls"; }
  static list(): string { return `${this.prefix()}/all`; }
  instanceBoom(): never { throw new Error("instance-boom"); }
}
