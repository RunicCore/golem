const RUN_LINE = /^(?:Recovered: )?.+ · \d+ ms$/;

/** Whether `text` is the line a watch prints after a good run: the result of each job, then the time. */
export function isRunLine(text: string): boolean {
  return RUN_LINE.test(text.trimEnd());
}

/** The lines of `output` that report a good watch run, in order. */
export function runLines(output: string): string[] {
  return output.split('\n').filter(isRunLine);
}
