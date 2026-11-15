import { REFUND_ATTEMPT_V1_ENV } from './refund-attempt.types';
import {
  amountToCentsExact,
  assertExactHundredthsAmount,
  availableShipmentRefundCapacity,
  classifyLegacyStripeRefundStatus,
  isCardPaymentMode,
  isHistoricalIssuedComplete,
  selectReturnRefundDrive,
  ShipmentRefundHoldError,
} from './shipment-refund-hold.types';

describe('shipment-refund-hold.types (S2.3)', () => {
  const previous = process.env[REFUND_ATTEMPT_V1_ENV];

  afterEach(() => {
    if (previous === undefined) delete process.env[REFUND_ATTEMPT_V1_ENV];
    else process.env[REFUND_ATTEMPT_V1_ENV] = previous;
  });

  describe('selectReturnRefundDrive', () => {
    it('selects ATTEMPT only when flag enabled and payment mode is test/live', () => {
      expect(
        selectReturnRefundDrive({
          paymentMode: 'test',
          env: { [REFUND_ATTEMPT_V1_ENV]: 'true' } as NodeJS.ProcessEnv,
        }),
      ).toBe('ATTEMPT');
      expect(
        selectReturnRefundDrive({
          paymentMode: 'live',
          env: { [REFUND_ATTEMPT_V1_ENV]: '1' } as NodeJS.ProcessEnv,
        }),
      ).toBe('ATTEMPT');
    });

    it('selects LEGACY for COD/Lipa/demo even when flag enabled', () => {
      const env = { [REFUND_ATTEMPT_V1_ENV]: 'true' } as NodeJS.ProcessEnv;
      expect(selectReturnRefundDrive({ paymentMode: 'cod', env })).toBe('LEGACY');
      expect(selectReturnRefundDrive({ paymentMode: 'lipa', env })).toBe('LEGACY');
      expect(selectReturnRefundDrive({ paymentMode: 'demo', env })).toBe('LEGACY');
    });

    it('selects LEGACY when flag disabled regardless of card mode', () => {
      const env = {} as NodeJS.ProcessEnv;
      expect(selectReturnRefundDrive({ paymentMode: 'test', env })).toBe('LEGACY');
      expect(selectReturnRefundDrive({ paymentMode: 'live', env })).toBe('LEGACY');
    });
  });

  it('recognises historical ISSUED as complete even when UNCLAIMED', () => {
    expect(
      isHistoricalIssuedComplete({
        refundStatus: 'ISSUED',
        refundDrive: 'UNCLAIMED',
      }),
    ).toBe(true);
    expect(
      isHistoricalIssuedComplete({
        refundStatus: 'PENDING',
        refundDrive: 'UNCLAIMED',
      }),
    ).toBe(false);
  });

  it('rejects sub-cent amounts before financial writes', () => {
    expect(() => assertExactHundredthsAmount(0.001)).toThrow(ShipmentRefundHoldError);
    expect(() => assertExactHundredthsAmount(0.004)).toThrow(ShipmentRefundHoldError);
    expect(() => amountToCentsExact(0.001)).toThrow(/sub-cent/);
    expect(assertExactHundredthsAmount(12.34)).toBe(12.34);
    expect(amountToCentsExact(12.34)).toBe(1234);
  });

  it('classifies Stripe refund statuses for LEGACY evidence', () => {
    expect(classifyLegacyStripeRefundStatus('succeeded')).toBe('SUCCEEDED');
    expect(classifyLegacyStripeRefundStatus('pending')).toBe('PENDING');
    expect(classifyLegacyStripeRefundStatus('requires_action')).toBe(
      'REQUIRES_ACTION',
    );
    expect(classifyLegacyStripeRefundStatus('failed')).toBe('FAILED');
    expect(classifyLegacyStripeRefundStatus('canceled')).toBe('CANCELED');
    expect(classifyLegacyStripeRefundStatus('processing')).toBe('UNKNOWN');
    expect(classifyLegacyStripeRefundStatus(null)).toBe('UNKNOWN');
  });

  it('computes available capacity as paymentTotal - refunded - reserved', () => {
    expect(
      availableShipmentRefundCapacity({
        paymentMerchandise: 80,
        paymentDelivery: 10,
        paymentTax: 10,
        refundedAmount: 20,
        reservedHoldTotal: 30,
      }),
    ).toBe(50);
  });

  it('detects card payment modes', () => {
    expect(isCardPaymentMode('test')).toBe(true);
    expect(isCardPaymentMode('live')).toBe(true);
    expect(isCardPaymentMode('cod')).toBe(false);
    expect(isCardPaymentMode('lipa')).toBe(false);
    expect(isCardPaymentMode('demo')).toBe(false);
  });
});
