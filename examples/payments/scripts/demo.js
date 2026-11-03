// Starts the stand-in provider and the API in this process on free ports, then submits one payment through the generated client.
import { createStandIn } from '../.build/dev/provider.js';
import { createApplication } from '../.build/server/src/application.js';
import { PaymentsClient } from '../.build/web/sdk/index.js';
import { submitPayment } from '../.build/web/src/submit-payment.js';

const provider = createStandIn();
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
const application = await createApplication({ baseUrl: `http://127.0.0.1:${provider.address().port}` });
await application.listen(0, '127.0.0.1');
try {
  const client = new PaymentsClient({ baseUrl: await application.getUrl() });
  const payment = await submitPayment(client, {
    merchant: { id: 'merchant-1', name: 'Book shop' },
    billing: { name: 'Accounts' },
    money: { amount: '12.50', currency: 'USD' },
    note: 'Order 123',
  });
  console.log(`Payment ${payment.id}: ${payment.money.currency} ${payment.money.amount}, charge ${payment.charge?.id} is ${payment.charge?.status}`);
} finally {
  await application.close();
  provider.close();
}
