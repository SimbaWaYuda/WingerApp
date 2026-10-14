/** Next courier tracking reference. The first booking is CR-10001. */
export function nextCourierReference(existingCount: number): string {
  const count = Number.isFinite(existingCount) && existingCount > 0 ? Math.floor(existingCount) : 0;
  return `CR-${count + 10001}`;
}

export type CourierTripDetails = {
  driverName: string | null;
  driverPhone: string | null;
  plateNumber: string | null;
  fee: number | null;
  trackingUrl: string | null;
};

export type CourierTripInput = {
  driverName?: unknown;
  driverPhone?: unknown;
  plateNumber?: unknown;
  courierFee?: unknown;
  trackingUrl?: unknown;
};

/** Blank fields clear that detail. A bad phone, fee, or link is rejected. */
export function parseCourierTripDetails(input: CourierTripInput): CourierTripDetails {
  return {
    driverName: optionalLabel(input.driverName, 80, 'Driver name'),
    driverPhone: optionalPhone(input.driverPhone),
    plateNumber: optionalPlate(input.plateNumber),
    fee: optionalFee(input.courierFee),
    trackingUrl: optionalTrackingUrl(input.trackingUrl),
  };
}

function optionalLabel(value: unknown, max: number, label: string): string | null {
  if (value == null || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (text.length > max) {
    throw new Error(`${label} must be ${max} characters or less`);
  }
  return text;
}

function optionalPhone(value: unknown): string | null {
  if (value == null || String(value).trim() === '') return null;
  const phone = String(value).trim();
  const digits = phone.replace(/\D/g, '');
  if (phone.length > 40 || digits.length < 5 || !/^[0-9+\-().\s]+$/.test(phone)) {
    throw new Error('Enter a driver phone number');
  }
  return phone;
}

function optionalPlate(value: unknown): string | null {
  const plate = optionalLabel(value, 20, 'Plate number');
  return plate ? plate.toUpperCase() : null;
}

function optionalFee(value: unknown): number | null {
  if (value == null || value === '') return null;
  const amount = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(amount) || amount < 0 || amount > 100000) {
    throw new Error('Courier fee must be a number from 0 to 100000');
  }
  return Math.round(amount * 100) / 100;
}

function optionalTrackingUrl(value: unknown): string | null {
  if (value == null || String(value).trim() === '') return null;
  const url = String(value).trim();
  if (url.length > 300 || !/^https?:\/\//i.test(url)) {
    throw new Error('Tracking link must start with http:// or https://');
  }
  return url;
}
