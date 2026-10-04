# Slice 5c — Stripe Connect eligibility & architecture assessment

**Status:** Written assessment only. No live Connect, production payouts, or payment-provider configuration is implemented in Slice 5a/5c.

## Current payment architecture

- Winger charges a **single platform PaymentIntent** (or demo acceptance) for the full multi-supplier order total.
- There is **no** Stripe Connect account linkage on `Supplier`, no destination charges, no separate charges and transfers, and no webhook-driven settlement.
- COD remains offline until supplier/admin marks delivery/payment collected.
- Commission Slice 5a records **accounting snapshots** in Postgres; it does **not** move funds to suppliers.

## Proposed target (not implemented)

Evaluate **Stripe Connect — Separate Charges and Transfers** for multi-supplier checkout:

1. Platform collects customer payment (as today, or per Connect rules once eligible).
2. After fulfilment / recognition rules, Winger initiates **Transfers** to each connected supplier account for net proceeds (line total − commission − any agreed adjustments).
3. Winger retains commission; payment processing fees are tracked as a **Winger expense** (per business decision), separately from commission revenue.

## Eligibility & configuration checklist (must confirm before build)

| Topic | Question | Owner |
|-------|----------|--------|
| Platform eligibility | Is the entity eligible for Stripe Connect in target markets? | Legal / Stripe |
| Connected accounts | Express vs Custom vs Standard for suppliers? | Product + Legal |
| KYC / onboarding | Who owns identity verification failures and payout holds? | Ops + Legal |
| Merchant of record | Platform vs supplier for tax receipts and chargebacks? | Legal / Tax |
| Payment fees | Confirm absorbing Stripe fees as Winger expense in Connect fee settings | Finance |
| Refunds | How are reverse transfers / transfer reversals applied per supplier line? | Finance + Stripe |
| Chargebacks | Fee allocation and commission clawback timing (Slice 5b+) | Finance + Legal |
| Payout timing | Align with `SETTLEABLE` commission status vs Stripe payout schedule | Product + Finance |
| Multi-supplier cart | One customer charge + N transfers vs N customer charges | Engineering |
| Cross-border | Currency, FX, and restricted country suppliers | Legal / Stripe |
| Demo mode | Keep demo path non-financial (already flagged `isDemo` on snapshots) | Engineering |

## Recommended sequencing

1. **Slice 5a (done scope):** commission accounting, agreements, audit — no Connect.
2. **Slice 5b:** refund clawbacks after refund money path exists.
3. **Connect spike:** sandbox Connect accounts + transfer dry-run behind feature flag.
4. **Production Connect:** only after checklist sign-off and legal/tax confirmation.

## Non-goals of this document

- No API keys, account IDs, or production dashboard changes.
- No claim of tax/VAT compliance.
- No automatic supplier payouts from `SETTLEABLE` status until Connect is approved and built.
