import 'package:flutter_test/flutter_test.dart';
import 'package:winger/features/supplier/commission_account_panel.dart';

void main() {
  test('valid ISO timestamp formats as local YYYY-MM-DD HH:mm, not raw ISO', () {
    const iso = '2026-11-14T20:58:21.611Z';
    final parsed = DateTime.parse(iso).toLocal();
    final expected =
        '${parsed.year.toString().padLeft(4, '0')}-'
        '${parsed.month.toString().padLeft(2, '0')}-'
        '${parsed.day.toString().padLeft(2, '0')} '
        '${parsed.hour.toString().padLeft(2, '0')}:'
        '${parsed.minute.toString().padLeft(2, '0')}';

    final formatted = formatSupplierEvidenceTimestamp(iso);
    expect(formatted, expected);
    expect(formatted.contains('T'), isFalse);
    expect(formatted.contains('Z'), isFalse);
    expect(formatted.contains('.'), isFalse);
    expect(RegExp(r'^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$').hasMatch(formatted), isTrue);
  });

  test('null empty and invalid timestamps do not throw and stay blank', () {
    expect(formatSupplierEvidenceTimestamp(null), '');
    expect(formatSupplierEvidenceTimestamp(''), '');
    expect(formatSupplierEvidenceTimestamp('   '), '');
    expect(formatSupplierEvidenceTimestamp('not-a-date'), '');
    expect(formatSupplierEvidenceTimestamp(42), '');
  });
}
