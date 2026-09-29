# Browser checks

Start with `npm run dev` and open http://127.0.0.1:5173. Keep React StrictMode enabled in src/main.tsx.

1. Refresh the page and save the initial payment. Expect a POST /payments request, HTTP 201, and a success message. This exercises the initial StrictMode effect setup/cleanup replay.
2. At a 390px viewport, use keyboard navigation through amount, currency, note and Save. Expect readable fields, visible focus and no horizontal page overflow.

`tests/browser/packed-runtime.test.ts` drives the same page with Playwright and
already covers save, field validation messages (including `Enter an amount.`),
request failure and retry, concurrent saves and disposal. These two checks cover what
that automated test does not: keyboard-only navigation and visible focus rendering.
