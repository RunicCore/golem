import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './App.js';
import { PaymentStore } from './payment-store.js';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('App root was not found.');

const originalDispose = PaymentStore.prototype.dispose;
Reflect.set(globalThis, 'storeDisposals', 0);
PaymentStore.prototype.dispose = function () {
  Reflect.set(globalThis, 'storeDisposals', Number(Reflect.get(globalThis, 'storeDisposals')) + 1);
  return originalDispose.call(this);
};

const reactRoot: Root = createRoot(rootElement);
Reflect.set(globalThis, 'unmountApp', () => reactRoot.unmount());
reactRoot.render(
  <StrictMode>
    <App baseUrl={location.origin} />
  </StrictMode>,
);
