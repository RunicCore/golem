export function positive(value: unknown): boolean {
  return typeof value === 'number' && value > 0;
}
