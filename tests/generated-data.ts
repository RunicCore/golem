/** Read emitted JSON data independently of its escaped TypeScript literal. */
export function generatedJsonData(source: string): string {
  const values: unknown[] = [];
  for (const match of source.matchAll(/JSON\.parse\(("(?:\\.|[^"\\])*")\)/g)) {
    values.push(JSON.parse(JSON.parse(match[1])));
  }
  return values.map((value) => JSON.stringify(value)).join('\n');
}
