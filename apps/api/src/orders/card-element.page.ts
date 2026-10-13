const publishableKeyPattern = /^pk_(test|live)_[A-Za-z0-9]+$/;

export function isStripePublishableKey(value: string | null | undefined): boolean {
  return publishableKeyPattern.test((value ?? '').trim());
}

/** Stripe.js card field. The card number stays in Stripe's frame. */
export function cardElementHtml(publishableKey: string | null | undefined): string {
  const key = isStripePublishableKey(publishableKey) ? publishableKey!.trim() : null;
  const keyLiteral = key == null ? 'null' : JSON.stringify(key);
  const unavailable = key == null ? 'Card payment is not configured' : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Card</title>
  <script src="https://js.stripe.com/v3/"></script>
  <style>
    html, body { margin: 0; background: #ffffff; color: #1F4D43; font-family: "Segoe UI", sans-serif; }
    #card-element { padding: 12px; border: 1px solid #c5d5cf; border-radius: 8px; background: #ffffff; }
    #card-error { color: #9b2c2c; font-size: 13px; min-height: 1.2em; margin-top: 8px; }
  </style>
</head>
<body>
  <div id="card-element"></div>
  <div id="card-error">${unavailable}</div>
  <script>
    const publishableKey = ${keyLiteral};
    const errorEl = document.getElementById('card-error');
    let stripe = null;
    let card = null;
    if (publishableKey) {
      stripe = Stripe(publishableKey);
      const elements = stripe.elements();
      card = elements.create('card', {
        hidePostalCode: true,
        style: {
          base: { fontSize: '16px', color: '#1F4D43', '::placeholder': { color: '#7d8f89' } },
          invalid: { color: '#9b2c2c' }
        }
      });
      card.mount('#card-element');
      card.on('change', function (event) {
        errorEl.textContent = event.error ? event.error.message : '';
      });
    }
    function reply(payload) {
      const message = Object.assign({ source: 'winger-card' }, payload);
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(message, '*');
      }
      if (window.WingerCard && window.WingerCard.postMessage) {
        window.WingerCard.postMessage(JSON.stringify(message));
      }
      if (window.flutter_inappwebview && window.flutter_inappwebview.callHandler) {
        window.flutter_inappwebview.callHandler('WingerCard', JSON.stringify(message));
      }
    }
    async function wingerCreatePaymentMethod() {
      if (!stripe || !card) {
        reply({ ok: false, message: 'Card payment is not configured' });
        return;
      }
      const result = await stripe.createPaymentMethod({ type: 'card', card: card });
      if (result.error) {
        const message = result.error.message || 'Card could not be saved';
        errorEl.textContent = message;
        reply({ ok: false, message: message });
        return;
      }
      const id = result.paymentMethod && result.paymentMethod.id;
      if (!id || id.indexOf('pm_') !== 0) {
        reply({ ok: false, message: 'Card could not be saved' });
        return;
      }
      reply({ ok: true, id: id });
    }
    window.wingerCreatePaymentMethod = wingerCreatePaymentMethod;
    window.addEventListener('message', function (event) {
      const data = event.data || {};
      if (data.type !== 'winger-create-payment-method') return;
      wingerCreatePaymentMethod();
    });
  </script>
</body>
</html>`;
}
