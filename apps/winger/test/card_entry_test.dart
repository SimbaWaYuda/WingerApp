import 'package:flutter_test/flutter_test.dart';
import 'package:winger/core/payments/card_entry.dart';

void main() {
  final now = DateTime(2026, 10, 9);

  test('accepts a spaced test card and a two-digit year', () {
    final card = parseCardEntry(
      number: '4242 4242 4242 4242',
      expiry: '12 / 30',
      cvc: '123',
      now: now,
    );
    expect(card.number, '4242424242424242');
    expect(card.expMonth, 12);
    expect(card.expYear, 2030);
    expect(card.cvc, '123');
  });

  test('accepts a single-digit month', () {
    final card = parseCardEntry(
      number: '4242424242424242',
      expiry: '6/28',
      cvc: '123',
      now: now,
    );
    expect(card.expMonth, 6);
    expect(card.expYear, 2028);
  });

  test('rejects a bad number, a past expiry, and a short cvc', () {
    expect(
      () => parseCardEntry(number: '4242', expiry: '12/30', cvc: '123', now: now),
      throwsFormatException,
    );
    expect(
      () => parseCardEntry(
        number: '4242424242424242',
        expiry: '01/26',
        cvc: '123',
        now: now,
      ),
      throwsFormatException,
    );
    expect(
      () => parseCardEntry(
        number: '4242424242424242',
        expiry: '12/30',
        cvc: '12',
        now: now,
      ),
      throwsFormatException,
    );
  });
}
