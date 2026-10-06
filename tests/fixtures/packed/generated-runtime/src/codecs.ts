export const positive = (value: number): boolean | string => value > 0 || 'Use a positive count';
export const encode = (value: number): string => value.toString(16);
export const decode = (value: string): number => Number.parseInt(value, 16);
