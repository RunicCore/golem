import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, before, after, type TestContext } from 'node:test';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { cli, command, npm } from '../support/process.js';
import { writeFixture } from '../support/consumer.js';
import { startRegistry, packageSpec, useReleaseChannel, type PackedRegistry } from '../../scripts/packed-registry.js';
import { ESBUILD, MOBX } from '../../scripts/third-party-installs.js';
import { copyFixture, copyFixtureFile, readFixture } from '../fixture-project.js';

let registry: PackedRegistry;
let browser: Browser;
async function trackBlockedEval(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const violations: string[] = [];
    Reflect.set(globalThis, 'blockedEvalSources', violations);
    document.addEventListener('securitypolicyviolation', event => {
      if (event.blockedURI === 'eval' || event.blockedURI === 'wasm-eval') {
        violations.push(event.blockedURI);
      }
    });
  });
}
// Listens on a free loopback port for the test and returns the server's origin.
async function listen(t: TestContext, server: http.Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Browser fixture did not bind');
  return `http://127.0.0.1:${address.port}`;
}
function serveHtml(response: http.ServerResponse, html: string, csp: string): void {
  response.setHeader('content-type', 'text/html');
  response.setHeader('content-security-policy', csp);
  response.end(html);
}
async function openPage(t: TestContext, options?: Parameters<Browser['newPage']>[0]): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage(options);
  t.after(() => page.close());
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(15_000);
  await trackBlockedEval(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  return { page, errors };
}
before(async () => {
  browser = await chromium.launch({ timeout: 30_000 });
  try { registry = await startRegistry(); }
  catch (error) { await browser.close(); throw error; }
});
after(async () => {
  await browser?.close();
  await registry?.close();
});

test('packed browser executes reusable APIs, nested MobX models and custom codecs', async t => {
  const root = registry.create(t, 'browser');
  await npm(root, ['install', '--save-dev', packageSpec(registry, '@exprtlabs/golem-model'), packageSpec(registry, '@exprtlabs/golem-openapi')]);
  await npm(root, ['install', '--save-dev', ESBUILD]);
  await npm(root, ['install', '--save-prod', packageSpec(registry, '@exprtlabs/golem'), MOBX]);
  writeFixture(root, { mobx: true, validation: true });
  const apiFile = path.join(root, 'api.json');
  const apiDocument = JSON.parse(fs.readFileSync(apiFile, 'utf8'));
  apiDocument.paths['/money'].get.parameters = [
    { name: 'request', in: 'query', required: true, schema: { type: 'integer' } },
  ];
  fs.writeFileSync(apiFile, JSON.stringify(apiDocument));
  await cli(root, ['generate']);
  copyFixtureFile(root, 'browser/packed-runtime/codecs.ts', 'src/codecs.ts');
  copyFixtureFile(root, 'browser/packed-runtime/cart.model.ts', 'src/cart.model.ts');
  await cli(root, ['generate']);
  copyFixtureFile(root, 'browser/packed-runtime/src/browser.ts', 'src/browser.ts');
  await cli(root, ['build']);
  await npm(root, ['prune', '--omit=dev'], { includeOptional: false });
  const bundled = await build({ entryPoints: [path.join(root, 'build/src/browser.js')], bundle: true, platform: 'browser', format: 'esm', write: false });
  const code = bundled.outputFiles[0].text;
  let requests = 0;
  let postRequests = 0;
  let abortStarted = false;
  let abortHandshake: http.ServerResponse | undefined;
  const held: Array<{ response: http.ServerResponse; amount: number }> = [];
  const reply = (response: http.ServerResponse, amount: number) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ amount, currency: 'USD' }));
  };
  const csp = `default-src 'none'; script-src 'self'; connect-src 'self'`;
  const html = readFixture('browser/packed-runtime/index.html');
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/abort/money') {
      abortStarted = true;
      abortHandshake?.end('ready');
      // Leave the actual HTTP request pending until the browser aborts it.
    } else if (request.url === '/abort-started') {
      if (abortStarted) response.end('ready');
      else abortHandshake = response;
    } else if (url.pathname === '/explicit-fetch/money') {
      reply(response, Number(url.searchParams.get('request')));
    } else if (url.pathname === '/money') {
      if (request.method === 'POST') postRequests++;
      requests++;
      if (requests <= 2) {
        held.push({ response, amount: Number(url.searchParams.get('request')) });
        if (held.length === 2) { reply(held[1].response, held[1].amount); reply(held[0].response, held[0].amount); }
      } else reply(response, requests);
    } else if (request.url === '/app.js') {
      response.setHeader('content-type', 'text/javascript');
      response.end(code);
    } else {
      serveHtml(response, html, csp);
    }
  });
  const origin = await listen(t, server);
  const { page, errors } = await openPage(t);
  const pageResponse = await page.goto(origin);
  assert.equal(pageResponse?.headers()['content-security-policy'], csp);
  assert.equal(requests, 0, 'loading the application does not send an API request');
  await page.getByRole('button', { name: 'Run' }).click();
  try {
    await page.waitForFunction(() => Boolean(document.querySelector('output')?.textContent), undefined, { timeout: 15_000 });
  } catch (error) {
    throw new Error(`Browser execution did not finish: ${JSON.stringify({ requests, abortStarted, errors })}`, { cause: error });
  }
  const result = JSON.parse(await page.locator('output').innerText());
  assert.equal(result.failure, undefined);
  assert.equal(result.nested, true);
  assert.deepEqual(result.amounts, [1, 2]);
  assert.equal(result.customValidationInitiallyValid, true);
  assert.equal(result.customValidationRejectsZero, true);
  assert.equal(result.customValidationError, 'Use a positive count');
  assert.equal(result.decodedCode, 255);
  assert.deepEqual(result.loading, [false, true, false, true, false]);
  assert.equal(result.idle, true);
  assert.deepEqual(result.values, [1, 2]);
  assert.equal(result.next, 3);
  assert.equal(result.rejected, true);
  assert.equal(result.cancelled, true);
  assert.equal(result.abortIdle, true);
  assert.equal(result.explicitFetch, 7, 'a caller-supplied native fetch keeps its browser receiver');
  assert.equal(abortStarted, true, 'cancellation happens after the request reaches the server');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /getMoney/);
  assert.deepEqual(result.json, { money: { amount: 2, currency: 'USD' }, note: 'draft', count: 2, code: 'ff' });
  assert.equal(postRequests, 0, 'invalid input never reaches the network');
  assert.equal(requests, 3);
  assert.deepEqual(errors, []);
  // protects: security: the packed bundle runs under a CSP without unsafe-eval, so any eval or new Function would be blocked and listed
  assert.deepEqual(await page.evaluate(() => Reflect.get(globalThis, 'blockedEvalSources')), []);
});

test('packed React form survives StrictMode, validation, retry and disposal', async t => {
  const root = registry.create(t, 'react-consumer');
  copyFixture(root, 'browser/react-app');
  useReleaseChannel(root, registry.workspaceVersion);
  await npm(root, ['install']);
  await cli(root, ['generate']);
  await cli(root, ['check']);
  await command(root, path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json']);
  await npm(root, ['prune', '--omit=dev'], { includeOptional: false });
  const { golem } = await import(pathToFileURL(path.join(root, 'node_modules/@exprtlabs/golem/dist/tooling/esbuild.js')).href) as typeof import('@exprtlabs/golem/esbuild');
  // The packed esbuild plugin scans the project's sources itself, so it loads TypeScript, a production dependency of this app, when it first rewrites a file. TypeScript runs from an optional native package that the prune removed, so the install restores it.
  await npm(root, ['install', '--omit=dev']);
  // The plugin opens the golem.yaml in the working directory of the build and loads the TypeScript beside that project's tsconfig, wherever this process runs from.
  const bundled = await build({
    entryPoints: [path.join(root, 'src/browser-test-entry.tsx')], outfile: path.join(root, 'browser/app.js'),
    bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true, absWorkingDir: root,
    // The development React build is the one where StrictMode replays effects.
    define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    plugins: [golem()],
  });
  const javascript = bundled.outputFiles.find(file => file.path.endsWith('.js'))?.text;
  const css = bundled.outputFiles.find(file => file.path.endsWith('.css'))?.text;
  assert.ok(javascript && css, 'the app bundles its entry and styles');
  const requests: unknown[] = [];
  let failNext = false;
  let holdNext = false;
  let held: http.ServerResponse | undefined;
  let aborted = false;
  const csp = `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'`;
  const html = readFixture('browser/react-app/index.html');
  const server = http.createServer(async (request, response) => {
    if (request.url === '/app.js') {
      response.setHeader('content-type', 'text/javascript'); response.end(javascript);
    } else if (request.url === '/app.css') {
      response.setHeader('content-type', 'text/css'); response.end(css);
    } else if (request.url === '/payments' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      requests.push(JSON.parse(body));
      response.setHeader('content-type', 'application/json');
      if (holdNext) {
        holdNext = false; held = response;
        response.on('close', () => { if (!response.writableEnded) aborted = true; });
      } else if (failNext) {
        failNext = false; response.statusCode = 500; response.end('{"message":"temporary failure"}');
      } else {
        response.statusCode = 201; response.end(body);
      }
    } else {
      serveHtml(response, html, csp);
    }
  });
  const origin = await listen(t, server);
  const { page, errors } = await openPage(t, { viewport: { width: 390, height: 844 } });
  const loaded = await page.goto(origin);
  assert.equal(loaded?.headers()['content-security-policy'], csp);
  await expect(page.getByRole('heading', { name: 'Payment editor' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => Reflect.get(globalThis, 'storeDisposals'))).toBe(1);
  assert.equal(requests.length, 0, 'StrictMode effect replay does not submit');
  await page.getByRole('spinbutton', { name: /^Amount\b/ }).fill('40');
  await page.getByLabel('Currency', { exact: true }).fill('eur');
  await page.getByLabel('Note', { exact: false }).fill('Lunch');
  await expect(page.locator('.summary-panel strong')).toHaveText('40 EUR: Lunch');
  await page.getByRole('button', { name: 'Save payment' }).click();
  await expect(page.getByRole('status')).toHaveText('Payment saved by the local demo server.');
  assert.deepEqual(requests, [{ amount: 40, currency: 'EUR' }]);

  await page.getByRole('spinbutton', { name: /^Amount\b/ }).fill('-1');
  await page.getByRole('button', { name: 'Save payment' }).click();
  await expect(page.locator('#amount-error')).toBeVisible();
  assert.equal(requests.length, 1);
  await page.getByRole('spinbutton', { name: /^Amount\b/ }).fill('');
  await page.getByRole('button', { name: 'Save payment' }).click();
  await expect(page.locator('#amount-error')).toHaveText('Enter an amount.');
  await page.getByRole('spinbutton', { name: /^Amount\b/ }).fill('41');
  await page.getByLabel('Note', { exact: false }).fill('x'.repeat(101));
  await page.getByRole('button', { name: 'Save payment' }).click();
  await expect(page.locator('#note-error')).toHaveText('Keep the note within 100 characters');
  assert.equal(requests.length, 1, 'all invalid form submissions stop before HTTP');
  await page.getByLabel('Note', { exact: false }).fill('Retry me');
  failNext = true;
  await page.getByRole('button', { name: 'Save payment' }).click();
  await expect(page.getByRole('alert')).toContainText('Could not save the payment');
  await expect(page.getByRole('spinbutton', { name: /^Amount\b/ })).toHaveValue('41');
  await expect(page.getByLabel('Note', { exact: false })).toHaveValue('Retry me');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('status')).toHaveText('Payment saved by the local demo server.');
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[2], { amount: 41, currency: 'EUR' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the 390px layout has no horizontal overflow');

  holdNext = true;
  await page.getByRole('button', { name: 'Save payment' }).click();
  await expect(page.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  await page.locator('form').dispatchEvent('submit');
  await expect.poll(() => requests.length).toBe(4);
  assert.equal(requests.length, 4, 'duplicate submit while saving sends only one request');
  await page.evaluate(() => Reflect.get(globalThis, 'unmountApp')());
  await expect.poll(() => aborted).toBe(true);
  assert.equal(await page.evaluate(() => Reflect.get(globalThis, 'storeDisposals')), 2);
  held?.end('{"amount":99,"currency":"USD"}');
  await expect(page.locator('#root')).toBeEmpty();
  assert.equal(requests.length, 4, 'no late duplicate request');
  assert.deepEqual(errors, []);
  // protects: security: the packed bundle runs under a CSP without unsafe-eval, so any eval or new Function would be blocked and listed
  assert.deepEqual(await page.evaluate(() => Reflect.get(globalThis, 'blockedEvalSources')), []);
});
