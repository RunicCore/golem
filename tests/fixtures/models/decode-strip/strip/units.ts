/** The wire form of a price: `{ amount }`, where the model holds `{ units }`. */
export function encodeUnits(value: { units: number }): { amount: string } {
  return { amount: String(value.units) };
}

export function decodeUnits(wire: { amount: string }): { units: number } {
  return { units: Number(wire.amount) };
}
