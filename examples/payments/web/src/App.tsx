import { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { getValidator } from '@exprtlabs/golem/validation';
import { PaymentsClient } from '../sdk/index.js';
import type { PaymentEditor } from './payment-editor.model.js';
import { PaymentStore } from './payment-store.js';
import { observeSummary } from './summary.js';
import './styles.css';

const apiUrl = window.location.origin; // The Vite dev server proxies /api to the API.

// #region observer-component
const AmountField = observer(function AmountField({ editor }: { editor: PaymentEditor }) {
  const error = getValidator(editor).errors['/money/amount']?.[0]; // Re-renders when the validation errors change.
  return (
    <label className="field">
      <span>Amount</span>
      <input
        aria-invalid={error ? true : undefined}
        inputMode="decimal"
        name="amount"
        onChange={event => editor.setAmount(event.currentTarget.value)}
        type="text"
        value={editor.money.amount} // Re-renders when the amount changes.
      />
      {error && <span className="field-error">{error}</span>}
    </label>
  );
});
// #endregion observer-component

const PaymentEditorView = observer(function PaymentEditorView({ store }: { store: PaymentStore }) {
  const validator = getValidator(store.editor);
  const currencyError = validator.errors['/money/currency']?.[0];
  const noteError = validator.error(['note']);

  return (
    <main className="page-shell">
      <section className="editor-card" aria-labelledby="editor-title">
        <div className="eyebrow">React + MobX</div>
        <h1 id="editor-title">Payment editor</h1>
        <p className="lede">Edit the amount, currency and note, then save the payment to the API.</p>
        <div className="summary-panel" aria-live="polite">
          <span className="summary-label">Live summary</span>
          <strong>{store.editor.summary}</strong>
        </div>
        <form className="payment-form" noValidate onSubmit={event => { event.preventDefault(); void store.save(); }}>
          <div className="field-grid">
            <AmountField editor={store.editor} />
            <label className="field">
              <span>Currency</span>
              <input
                aria-invalid={currencyError ? true : undefined}
                maxLength={3}
                name="currency"
                onChange={event => store.editor.setCurrency(event.currentTarget.value)}
                spellCheck={false}
                type="text"
                value={store.editor.money.currency}
              />
              {currencyError && <span className="field-error">{currencyError}</span>}
            </label>
          </div>
          <label className="field">
            <span>Note <small>(optional)</small></span>
            <textarea
              aria-invalid={noteError ? true : undefined}
              name="note"
              onChange={event => store.editor.setNote(event.currentTarget.value)}
              rows={3}
              value={store.editor.note}
            />
            {noteError && <span className="field-error">{noteError}</span>}
          </label>
          <button className="save-button" disabled={store.saveState === 'saving'} type="submit">
            {store.saveState === 'saving' ? 'Saving…' : store.saveState === 'error' ? 'Try again' : 'Save payment'}
          </button>
          <div aria-live="polite" className="form-status" role={store.saveState === 'error' ? 'alert' : 'status'}>
            {store.saveState === 'success' && <span className="success-message">{store.message}</span>}
            {store.saveState === 'error' && <span className="error-message">{store.message}</span>}
            {store.sending && <span className="saving-message">Sending to {apiUrl}…</span>}
          </div>
        </form>
      </section>
    </main>
  );
});

export function App() {
  const [store, setStore] = useState<PaymentStore | null>(null);
  useEffect(() => {
    const current = new PaymentStore(new PaymentsClient({ baseUrl: apiUrl }));
    const stop = observeSummary(current.editor, summary => { document.title = summary; });
    setStore(current);
    return () => { stop(); current.dispose(); };
  }, []);
  return store ? <PaymentEditorView store={store} /> : null;
}
