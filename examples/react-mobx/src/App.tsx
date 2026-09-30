import { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { getValidator } from '@exprtlabs/golem/validation';
import { createPaymentStore, type PaymentStore } from './payment-store.js';
import './styles.css';

const demoApiUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3002';

// #region observer-component
const PaymentEditorView = observer(function PaymentEditorView({ store }: { store: PaymentStore }) {
  const validator = getValidator(store.editor);
  const amountIssue = validator.errors['/money/amount']?.[0];
  const amountError = amountIssue && Number.isNaN(store.editor.money.amount)
    ? 'Enter an amount.'
    : amountIssue;
  const currencyError = validator.errors['/money/currency']?.[0];
  const noteError = validator.error('note');
  const amountValue = Number.isNaN(store.editor.money.amount)
    ? ''
    : String(store.editor.money.amount);

  return (
    <main className="page-shell">
      <section className="editor-card" aria-labelledby="editor-title">
        <div className="eyebrow">React + MobX recipe</div>
        <h1 id="editor-title">Payment editor</h1>
        <p className="lede">
          Edit the amount, currency, and note, then save this local demo payment.
        </p>

        <div className="summary-panel" aria-live="polite">
          <span className="summary-label">Live summary</span>
          <strong>{store.editor.summary}</strong>
        </div>

        <form
          className="payment-form"
          onSubmit={event => {
            event.preventDefault();
            void store.save();
          }}
          noValidate
        >
          <div className="field-grid">
            <label className="field">
              <span>Amount</span>
              <input
                aria-describedby={amountError ? 'amount-error' : undefined}
                aria-invalid={amountError ? true : undefined}
                inputMode="decimal"
                min="0"
                name="amount"
                onChange={event => {
                  const value = event.currentTarget.value;
                  store.editor.setAmount(value === '' ? Number.NaN : Number(value));
                }}
                step="0.01"
                type="number"
                value={amountValue}
              />
              {amountError && <span className="field-error" id="amount-error">{amountError}</span>}
            </label>

            <label className="field">
              <span>Currency</span>
              <input
                aria-describedby={currencyError ? 'currency-error' : undefined}
                aria-invalid={currencyError ? true : undefined}
                maxLength={3}
                name="currency"
                onChange={event => store.editor.setCurrency(event.currentTarget.value)}
                spellCheck={false}
                type="text"
                value={store.editor.money.currency}
              />
              {currencyError && <span className="field-error" id="currency-error">{currencyError}</span>}
            </label>
          </div>

          <label className="field">
            <span>Note <small>(optional)</small></span>
            <textarea
              aria-describedby={noteError ? 'note-error' : undefined}
              aria-invalid={noteError ? true : undefined}
              maxLength={120}
              name="note"
              onChange={event => store.editor.setNote(event.currentTarget.value)}
              placeholder="What is this payment for?"
              rows={3}
              value={store.editor.note}
            />
            <span className="field-meta">
              {noteError && <span className="field-error" id="note-error">{noteError}</span>}
              <span>{store.editor.note.length}/100</span>
            </span>
          </label>

          <button className="save-button" disabled={store.saving} type="submit">
            {store.saving ? 'Saving…' : store.saveState === 'error' ? 'Try again' : 'Save payment'}
          </button>

          <div aria-live="polite" className="form-status" role={store.saveState === 'error' ? 'alert' : 'status'}>
            {store.saveState === 'success' && <span className="success-message">{store.message}</span>}
            {store.saveState === 'error' && <span className="error-message">{store.message}</span>}
            {store.saving && <span className="saving-message">Sending to the local demo server…</span>}
          </div>
        </form>

        <p className="demo-note">
          Local demo only. Save sends your payment details to {demoApiUrl}.
        </p>
      </section>
    </main>
  );
  // #endregion observer-component
});

export function App() {
  const [store, setStore] = useState<PaymentStore | null>(null);

  useEffect(() => {
    const current = createPaymentStore(demoApiUrl);
    setStore(current);
    return () => current.dispose();
  }, []);

  return store ? <PaymentEditorView store={store} /> : null;
}
