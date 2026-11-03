export function validateAa(value: unknown): boolean | string { return typeof value === 'string' && value !== ''; }
export function validateZ(value: unknown): boolean | string { return typeof value === 'number' && value >= 0; }
