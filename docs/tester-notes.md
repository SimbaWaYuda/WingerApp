# Winger tester notes

Closed test with Stripe test cards. No live charge, and no booking is sent to a courier company.

Someone on another computer opens the web app. The API and the database stay on this computer. Postgres is not open to the internet. This computer has to stay on.

## Public address

| What | Address |
|------|---------|
| Web app for testers | https://wingermarket.com |
| API | https://wingermarket.com |
| Stripe webhook | `POST https://wingermarket.com/stripe/webhook` |

Shop, API, and webhook share one hostname. The webhook listens for `payment_intent.succeeded` and `payment_intent.payment_failed` in test mode. The existing S3 POS webhook was left as it is.

On this computer, the Windows app and the Android emulator still use the local API. Testers off this computer use https://wingermarket.com.

## Address for this round

Cut over on 23 October 2026 to the named Cloudflare tunnel on `wingermarket.com`. Invite people to that link. Leave this computer on. Restarting the named tunnel keeps the same address.

## Result

Passed on 16 October 2026, on this computer.

- Decline card `4000 0000 0000 0002` showed "Your card was declined."
- Test card checkout `WG-10094` was paid in test mode and delivered. AeroPulse is booked with Bot Sender · `CR-10006`, driver Jim. Pulse Watch Pro is booked with Bot Sender · `CR-10007`.
- `WG-10096` went from shipped (`CR-10009`) to delivered with driver Mama K, plate `TZXY 001`, and courier fee `$1.00`.
- `WG-10095` was delivered.
- From an iPhone, off this computer, the web app showed API Online. `WG-10097` was paid with a test card and delivered. Pulse Watch Pro is booked with Bot Sender · `CR-10010`, driver Deo N, plate `TZG 27 GD`.

Passed on 17 October 2026, on the public link from an iPhone.

- **Forgot password?** for `kalilo.msuya@example.com` reached the admin dashboard. The admin saved a temporary password, and the request list cleared.
- Kijani Payments still showed commission waiting **$0.00**. The Pulse Watch payout of USD 287.10 was already sent. Cash commission stays at **$24.00**. Later test-card orders are demo, so they do not raise this number.

## Sign in

Password for every seeded account: `demo1234`

Testers can create a customer or supplier account from **New here? Create an account**. They cannot create an admin account. Sign in as `admin@winger.example` and use **Create admin account** on the admin dashboard.

| Role | Email | Use |
|------|--------|-----|
| Customer | `amina.mwangi@example.com` | Shop and pay |
| Supplier (Kijani Tech) | `supplier@kijani.example` | Ship, add the driver, send a test payout |
| Admin | `admin@winger.example` | Read commission |

On the login screen, pick the matching role before Continue. The app runs here as the Windows app, Chrome at `http://localhost:61258`, or the Android emulator. The emulator talks to this computer. It is not a public app.

Language can be English, Español, or Kiswahili.

## Reset a password

There is no password email. **Forgot password?** on the login screen asks an admin to set one.

1. The person enters their email and sends the request. The app says the request was sent. A missing email gets the same reply.
2. Sign in as the admin. **Reset a password** on the dashboard lists who asked. Set a temporary password and tell that person.
3. They sign in with the temporary password. The app stays on **Choose your password** until they save their own. The temporary password then stops working.
4. This works for customers, suppliers, and admins, on the Windows app, the phone, and the web app.

## Pay with a test card

1. Sign in as the customer.
2. Add a product to the cart and check out with a card.
3. Use `4242 4242 4242 4242`, any future expiry, and any CVC. `4000 0000 0000 0002` is the decline card.
4. Prices can show in Tanzanian shillings. The charge settles in US dollars. Commission stays in dollars.

Demo checkout is a separate path. It is tracked and is not real money. It never becomes a Stripe payout.

Pay on delivery is allowed. That order is recorded in Winger and is not sent to Stripe.

## Book the courier inside Winger

Sign in as the supplier and open the order.

1. **Book courier** asks you to confirm. It marks the shipment shipped and saves a Winger reference such as `CR-10001`. It does not ask for a driver, and it does not call Bot Sender or any other courier.
2. **Courier details** is the only form for driver name, phone, plate, courier fee, and tracking link. Save it after the line is shipped or delivered. Saving again replaces the previous set.
3. The courier fee is shown to the customer. It does not change the order total, tax, or commission.
4. Mark the line delivered.

The customer order should show `Booked with {courier name} · {CR reference}`, plus the driver fields from the latest save. A tracking link opens only when one was entered.

Pickup, and a shipment the supplier delivers themselves, do not create a courier booking.

## What Payments should show

Sign in as the supplier and open Payments. Stripe payouts for Kijani are already connected in test mode.

Press **Send settleable payouts** once after the card order is delivered.

| Card | What it means |
|------|----------------|
| Commission still waiting | Card commission that has not been paid out yet |
| Cash stays in Winger | Cash-order commission. It is not sent to Stripe |
| Payouts already sent | Dollars Stripe has accepted for the supplier |

The payout is the item total minus commission, in the currency Stripe settled. Tax and delivery stay on the platform. A shilling checkout still pays the supplier in dollars.

The rehearsal already sent one payout: Pulse Watch, supplier share **USD 287.10**. After that, commission still waiting read **$0.00**, cash stayed at **$24.00**, and payouts already sent read **$287.10**. Pending commission can stay above zero. That is commission on orders that are not ready to pay out.

On the commission lines, the card order reads `Payout sent USD …`. Each cash order reads `Cash stays in Winger`.

Pressing the button again, when nothing new is ready, does not send another payout.

## Admin

Sign in as the admin and open Commission. Card commission moves through pending, recognized, and settleable as the order is paid and delivered. Demo commission is listed apart from those three and is not real money.

## Stop if you see this

- A live card charge, or a request for a real card number
- Book courier asking for the driver (that belongs only in Courier details)
- A cash order creating a Stripe payout
- The app trying to reach a courier company
- A tester off this computer who cannot sign in
