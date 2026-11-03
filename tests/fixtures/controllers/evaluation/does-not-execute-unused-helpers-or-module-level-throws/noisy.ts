throw new Error('module-side-effect');
export function rootPath(): string { return "/root"; }
export function unused(): never { throw new Error("unused-helper"); }
