export function notReserved(value: { amount: number; currency: string }): boolean {
  return value.currency !== 'XXX';
}
