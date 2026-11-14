/** The wire form of a price: `{ amount }`, where the model holds `{ units }`. */
export function encodeUnits(value: { units: number }): { amount: string } {
  return { amount: String(value.units) };
}

export function decodeUnits(wire: { amount: string }): { units: number } {
  return { units: Number(wire.amount) };
}

/** A value of a class: the model holds an instance, and the wire holds `{ amount }`. */
export class Price {
  public constructor(public readonly units: number) {}
}

export function encodePrice(value: Price): { amount: string } {
  return { amount: String(value.units) };
}

export function decodePrice(wire: { amount: string }): Price {
  return new Price(Number(wire.amount));
}
