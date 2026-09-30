export function notBlank(value: string): boolean | string { return value.trim().length > 0 || "blank"; }
