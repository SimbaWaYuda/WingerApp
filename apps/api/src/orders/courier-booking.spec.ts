import { nextCourierReference, parseCourierTripDetails } from './courier-booking';

describe('courier booking reference', () => {
  it('starts at CR-10001 and counts existing bookings', () => {
    expect(nextCourierReference(0)).toBe('CR-10001');
    expect(nextCourierReference(3)).toBe('CR-10004');
  });
});

describe('courier trip details', () => {
  it('keeps driver, phone, plate, fee, and an http tracking link', () => {
    expect(
      parseCourierTripDetails({
        driverName: ' Amina ',
        driverPhone: '+254 712 345 678',
        plateNumber: 'kaa 001a',
        courierFee: '12.5',
        trackingUrl: 'https://track.example/CR-10001',
      }),
    ).toEqual({
      driverName: 'Amina',
      driverPhone: '+254 712 345 678',
      plateNumber: 'KAA 001A',
      fee: 12.5,
      trackingUrl: 'https://track.example/CR-10001',
    });
  });

  it('clears blank fields and rejects a link that is not http', () => {
    expect(
      parseCourierTripDetails({
        driverName: ' ',
        driverPhone: '',
        plateNumber: '',
        courierFee: '',
        trackingUrl: '',
      }),
    ).toEqual({
      driverName: null,
      driverPhone: null,
      plateNumber: null,
      fee: null,
      trackingUrl: null,
    });
    expect(() => parseCourierTripDetails({ trackingUrl: 'javascript:alert(1)' })).toThrow(
      /http/,
    );
  });
});
