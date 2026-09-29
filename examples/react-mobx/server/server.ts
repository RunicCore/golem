import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const port = Number(process.env.PAYMENT_DEMO_PORT ?? '3002');
const allowedOrigin = process.env.PAYMENT_DEMO_ORIGIN ?? 'http://127.0.0.1:5173';

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 1024 * 1024) throw new Error('Request body is too large.');
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

function isMoney(value: unknown): value is { amount: number; currency: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const amount = Reflect.get(value, 'amount');
  const currency = Reflect.get(value, 'currency');
  return typeof amount === 'number'
    && Number.isFinite(amount)
    && amount >= 0
    && typeof currency === 'string'
    && /^[A-Z]{3}$/.test(currency);
}

const server = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Origin': allowedOrigin,
    });
    response.end();
    return;
  }

  if (request.method !== 'POST' || request.url !== '/payments') {
    writeJson(response, 404, { message: 'Only POST /payments is available in this demo.' });
    return;
  }

  try {
    const body = await readBody(request);
    if (!isMoney(body)) {
      writeJson(response, 400, { message: 'Expected a non-negative amount and a three-letter currency.' });
      return;
    }
    writeJson(response, 201, body);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Invalid JSON request.';
    writeJson(response, 400, { message });
  }
});

server.on('error', error => {
  console.error(`Payment demo server failed: ${error.message}`);
  process.exitCode = 1;
});

const close = (): void => {
  server.close(() => process.exit(0));
};

process.once('SIGINT', close);
process.once('SIGTERM', close);

server.listen(port, '127.0.0.1', () => {
  console.log(`Payment demo API listening at http://127.0.0.1:${port}`);
});
