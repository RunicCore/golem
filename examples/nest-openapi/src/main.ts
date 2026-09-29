import { createApplication } from './application.js';

const rawPort = process.env.PORT;
if (rawPort !== undefined && !/^\d+$/.test(rawPort.trim())) {
  throw new Error(`PORT must be a number; received "${rawPort}".`);
}
const port = rawPort === undefined ? 3000 : Number(rawPort.trim());
if (port < 0 || port > 65535) {
  throw new Error(`PORT must be between 0 and 65535; received "${rawPort}".`);
}
const application = await createApplication();
await application.listen(port, '127.0.0.1');
console.log(`Payments API: ${await application.getUrl()}/api/payments/transactions`);
