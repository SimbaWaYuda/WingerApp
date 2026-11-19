import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:winger/core/l10n/winger_strings.dart';
import 'package:winger/features/supplier/supplier_screens.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final s = WingerStrings(const Locale('en'));

  test('maps supplier routes to localised titles', () {
    expect(supplierShellTitle(s, '/supplier'), s.t('overview'));
    expect(supplierShellTitle(s, '/supplier/orders'), s.t('orders'));
    expect(supplierShellTitle(s, '/supplier/products'), s.t('catalogue'));
    expect(supplierShellTitle(s, '/supplier/returns'), s.t('returns'));
    expect(supplierShellTitle(s, '/supplier/delivery'), s.t('deliveryFees'));
    expect(supplierShellTitle(s, '/supplier/payments'), s.t('payments'));
    expect(supplierShellTitle(s, '/supplier/more'), s.t('more'));
  });

  test('nested supplier routes resolve to parent titles', () {
    expect(supplierShellTitle(s, '/supplier/orders/WG-10125'), s.t('orders'));
    expect(supplierShellTitle(s, '/supplier/products/edit'), s.t('catalogue'));
    expect(supplierShellTitle(s, '/supplier/returns/open'), s.t('returns'));
    expect(supplierShellTitle(s, '/supplier/payments/remit'), s.t('payments'));
  });

  test('unknown path uses overview fallback', () {
    expect(supplierShellTitle(s, '/supplier/unknown-feature'), s.t('overview'));
    expect(supplierShellTitle(s, '/somewhere-else'), s.t('overview'));
  });

  test('titles are not hardcoded English when locale differs', () {
    final sw = WingerStrings(const Locale('sw'));
    expect(supplierShellTitle(sw, '/supplier/orders'), sw.t('orders'));
    expect(supplierShellTitle(sw, '/supplier/orders'), isNot('Orders'));
    expect(supplierShellTitle(sw, '/supplier/payments'), sw.t('payments'));
  });
}
