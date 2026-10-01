// A local stand-in for a third-party payment provider. Only `npm run dev` starts it.
import { createServer } from 'node:http';

const port = Number(process.env.PROVIDER_PORT ?? '3001');
const charges = new Map<string, { id: string; money: { amount: string; currency: string }; createdAt: string; settlesOn: string }>();

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const json = (status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  if (request.headers.authorization !== 'Bearer dev-token') return json(401, { message: 'Send "Authorization: Bearer dev-token".' });
  if (url.pathname === '/events') {
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    return response.end('{"id":1}\n{"id":2}\n');
  }
  if (url.pathname === '/events/lines') {
    response.writeHead(200, { 'content-type': 'application/vnd.provider.events' });
    return response.end('7\n8\n');
  }
  if (request.method === 'GET' && url.pathname === '/charges') return json(200, [...charges.values()]);
  if (request.method === 'GET' && url.pathname.startsWith('/charges/')) {
    const found = charges.get(url.pathname.slice('/charges/'.length));
    return found ? json(200, found) : json(404, { message: 'No such charge' });
  }
  if (request.method === 'POST' && url.pathname === '/charges') {
    let text = '';
    for await (const chunk of request) text += chunk;
    const id = `charge-${charges.size + 1}`;
    const charge = { id, money: JSON.parse(text), createdAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), settlesOn: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10) };
    charges.set(id, charge);
    return json(201, charge);
  }
  return json(404, { message: 'Not part of the stand-in provider.' });
});

server.listen(port, '127.0.0.1', () => console.log(`Stand-in provider: http://127.0.0.1:${port} (token: dev-token)`));
process.once('SIGINT', () => server.close(() => process.exit(0)));
process.once('SIGTERM', () => server.close(() => process.exit(0)));
