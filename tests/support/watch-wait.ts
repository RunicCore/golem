/** Polls `check` until it holds. A message that reports state is a function: it runs when the wait times out, not when the wait starts. */
export async function until(check: () => boolean, message: string | (() => string), timeout = 25_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${typeof message === 'function' ? message() : message}`);
}
