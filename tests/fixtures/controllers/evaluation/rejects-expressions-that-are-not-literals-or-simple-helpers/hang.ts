function hang(): string {
  let value = 0;
  while (true) value += 1;
  return String(value);
}
export const ROUTE = hang();
