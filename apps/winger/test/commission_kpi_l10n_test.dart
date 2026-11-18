import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:winger/core/l10n/winger_strings.dart';

/// S2.6.20.83 — Swahili commissionWaiting vs pendingCommission distinction.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  WingerStrings s(String code) => WingerStrings(Locale(code));

  group('commission KPI labels', () {
    test('EN and ES commission labels remain unchanged', () {
      expect(s('en').t('commissionWaiting'), 'Commission still waiting');
      expect(s('en').t('pendingCommission'), 'Pending commission');
      expect(s('es').t('commissionWaiting'), 'Comisión aún pendiente');
      expect(s('es').t('pendingCommission'), 'Comisión pendiente');
    });

    test('SW commissionWaiting and pendingCommission are distinct', () {
      final waiting = s('sw').t('commissionWaiting');
      final pending = s('sw').t('pendingCommission');
      expect(waiting, 'Kamisheni inayosubiri malipo');
      expect(pending, 'Kamisheni haijatambuliwa');
      expect(waiting, isNot(equals(pending)));
    });

    test('all locales keep both keys non-empty and distinct', () {
      for (final locale in WingerStrings.supported) {
        final strings = WingerStrings(locale);
        final waiting = strings.t('commissionWaiting');
        final pending = strings.t('pendingCommission');
        expect(waiting, isNotEmpty, reason: '$locale commissionWaiting');
        expect(pending, isNotEmpty, reason: '$locale pendingCommission');
        expect(
          waiting,
          isNot(equals(pending)),
          reason: '$locale commission labels must differ',
        );
        // Keys used by Supplier Payments (both) and Admin commission totals
        // (pendingCommission) must resolve to translated copy, not raw keys.
        expect(waiting, isNot(equals('commissionWaiting')));
        expect(pending, isNot(equals('pendingCommission')));
      }
    });
  });
}
