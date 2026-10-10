import 'package:flutter/services.dart';

class ParsedCard {
  const ParsedCard({
    required this.number,
    required this.expMonth,
    required this.expYear,
    required this.cvc,
  });

  final String number;
  final int expMonth;
  final int expYear;
  final String cvc;
}

/// Reads a card the customer typed. Throws [FormatException] when it is incomplete.
ParsedCard parseCardEntry({
  required String number,
  required String expiry,
  required String cvc,
  DateTime? now,
}) {
  final digits = number.replaceAll(RegExp(r'\D'), '');
  if (digits.length < 13 || digits.length > 19 || !_luhn(digits)) {
    throw const FormatException('card');
  }
  final match = RegExp(r'^(\d{2})\s*/\s*(\d{2}|\d{4})$').firstMatch(expiry.trim());
  if (match == null) throw const FormatException('expiry');
  final month = int.parse(match.group(1)!);
  var year = int.parse(match.group(2)!);
  if (year < 100) year += 2000;
  if (month < 1 || month > 12) throw const FormatException('expiry');
  final today = now ?? DateTime.now();
  final expired = year < today.year || (year == today.year && month < today.month);
  if (expired) throw const FormatException('expiry');
  final cvcDigits = cvc.replaceAll(RegExp(r'\D'), '');
  if (cvcDigits.length < 3 || cvcDigits.length > 4) {
    throw const FormatException('cvc');
  }
  return ParsedCard(
    number: digits,
    expMonth: month,
    expYear: year,
    cvc: cvcDigits,
  );
}

bool _luhn(String digits) {
  var sum = 0;
  var alternate = false;
  for (var i = digits.length - 1; i >= 0; i--) {
    var n = int.parse(digits[i]);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 == 0;
}

const _stripeChannel = MethodChannel('winger/stripe');

/// Sends the card to Stripe on the device and returns a PaymentMethod id.
Future<String> createStripePaymentMethod({
  required ParsedCard card,
  required String publishableKey,
}) async {
  try {
    final id = await _stripeChannel.invokeMethod<String>('createCardPaymentMethod', {
      'number': card.number,
      'expMonth': card.expMonth,
      'expYear': card.expYear,
      'cvc': card.cvc,
      'publishableKey': publishableKey,
    });
    if (id == null || !id.startsWith('pm_')) {
      throw Exception('Card could not be saved');
    }
    return id;
  } on MissingPluginException {
    throw Exception('Card entry is available on the Android app.');
  } on PlatformException catch (error) {
    final message = error.message?.trim();
    throw Exception(
      message == null || message.isEmpty ? 'Card could not be saved' : message,
    );
  }
}
