import { nextCourierReference } from './courier-booking';

describe('courier booking reference', () => {
  it('starts at CR-10001 and counts existing bookings', () => {
    expect(nextCourierReference(0)).toBe('CR-10001');
    expect(nextCourierReference(3)).toBe('CR-10004');
  });
});
