/** A test file and the seconds that a run of its own process takes. */
export interface CostedFile { readonly file: string; readonly seconds: number }

/**
 * A run's wall time must stay under this share of the tier ceiling. The seconds of a file come from an earlier run at another
 * load, so the estimate is off by some tenths: a group that the estimate puts at the ceiling is cut by it.
 */
const CEILING_SHARE = 0.75;

/**
 * The wall time of a run of these files, `width` at once. The recorded seconds of a file are its wall time inside a full run that
 * keeps `width` files going, so the run's wall time is their sum shared over the width (measured: 16 files, 1990 s recorded, took 254 s in one run at width 8).
 * A file alone runs faster than its recorded seconds (measured: 214 s recorded, 48 s alone), so the longest file adds no floor of its own.
 */
export function estimateWall(seconds: readonly number[], width: number): number {
  return seconds.reduce((sum, value) => sum + value, 0) / width;
}

/**
 * Cuts the files into the fewest runs whose estimated wall time (`estimateWall`) fits the share of the ceiling that one run may
 * use, longest file first and each into the run with the least work so far. Every file lands in exactly one run. A file that
 * alone costs more than that share gets a run of its own: no cut makes it fit, and it must not force a cut of the others.
 */
export function splitForCeiling(files: readonly CostedFile[], { width, ceiling }: { readonly width: number; readonly ceiling: number }): CostedFile[][] {
  const budget = ceiling * CEILING_SHARE;
  const fits = (group: readonly CostedFile[]): boolean => estimateWall(group.map(item => item.seconds), width) <= budget;
  const longestFirst = [...files].sort((a, b) => b.seconds - a.seconds || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const alone = longestFirst.filter(item => !fits([item]));
  const others = longestFirst.filter(item => fits([item]));
  const deal = (count: number): CostedFile[][] => {
    const groups = Array.from({ length: count }, () => ({ files: [] as CostedFile[], work: 0 }));
    for (const item of others) {
      const least = groups.reduce((best, group) => group.work < best.work ? group : best);
      least.files.push(item);
      least.work += item.seconds;
    }
    return groups.map(group => group.files);
  };
  let groups = others.length ? deal(1) : [];
  // Each file of `others` fits alone, so the loop ends by `others.length` runs at the latest.
  for (let count = 2; !groups.every(fits); count++) groups = deal(count);
  return [...alone.map(item => [item]), ...groups];
}
