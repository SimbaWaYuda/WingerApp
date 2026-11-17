import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:winger/core/l10n/winger_strings.dart';
import 'package:winger/core/widgets/role_shell.dart';
import 'package:winger/features/customer/customer_screens.dart';
import 'package:winger/features/supplier/supplier_screens.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('customer destinations', () {
    test('maps Home Search Cart Orders Account with cart badge', () {
      final dest = customerDestinations(cartCount: 3, unreadNotifications: 2);
      expect(dest.map((d) => d.labelKey).toList(), [
        'home',
        'search',
        'cart',
        'orders',
        'account',
      ]);
      expect(dest.map((d) => d.path).toList(), [
        '/customer',
        '/customer/search',
        '/customer/cart',
        '/customer/orders',
        '/customer/account',
      ]);
      expect(dest[2].badgeCount, 3);
      expect(dest[4].badgeCount, 2);
      expect(selectedShellDestinationIndex('/customer/checkout', dest), 2);
      expect(selectedShellDestinationIndex('/customer/orders/abc', dest), 3);
    });
  });

  group('supplier destinations', () {
    test('mobile maps Overview Orders Catalogue More', () {
      final dest = supplierMobileDestinations(openReturns: 4);
      expect(dest.map((d) => d.labelKey).toList(), [
        'overview',
        'orders',
        'catalogue',
        'more',
      ]);
      expect(dest.last.path, '/supplier/more');
      expect(dest.last.badgeCount, 4);
      expect(selectedShellDestinationIndex('/supplier/returns', dest), 3);
      expect(selectedShellDestinationIndex('/supplier/payments', dest), 3);
    });

    test('wide destinations preserve all existing routes', () {
      final dest = supplierDestinations(openReturns: 1);
      expect(dest.map((d) => d.path).toList(), [
        '/supplier',
        '/supplier/orders',
        '/supplier/products',
        '/supplier/returns',
        '/supplier/delivery',
        '/supplier/payments',
      ]);
    });

    test('More menu exposes payments delivery returns', () {
      final more = supplierMoreMenuDestinations(openReturns: 2);
      expect(more.map((d) => d.labelKey).toList(), [
        'payments',
        'deliveryFees',
        'returns',
      ]);
      expect(more.map((d) => d.path).toList(), [
        '/supplier/payments',
        '/supplier/delivery',
        '/supplier/returns',
      ]);
    });
  });

  group('shell chrome', () {
    test('compact uses bottom nav', () {
      expect(
        resolveShellChrome(
          width: 390,
          layoutKind: ShellLayoutKind.customerMarketplace,
        ),
        ShellChrome.bottom,
      );
      expect(
        resolveShellChrome(
          width: 899,
          layoutKind: ShellLayoutKind.operations,
        ),
        ShellChrome.bottom,
      );
    });

    test('wide operations uses side nav', () {
      expect(
        resolveShellChrome(
          width: 900,
          layoutKind: ShellLayoutKind.operations,
        ),
        ShellChrome.side,
      );
    });

    test('wide customer marketplace is top on web and side on native', () {
      final chrome = resolveShellChrome(
        width: 1200,
        layoutKind: ShellLayoutKind.customerMarketplace,
      );
      if (kIsWeb) {
        expect(chrome, ShellChrome.marketplaceTop);
      } else {
        expect(chrome, ShellChrome.side);
      }
    });
  });

  group('localisation', () {
    test('EN ES SW navigation labels resolve', () {
      for (final locale in WingerStrings.supported) {
        final strings = WingerStrings(locale);
        expect(strings.t('home'), isNotEmpty);
        expect(strings.t('search'), isNotEmpty);
        expect(strings.t('cart'), isNotEmpty);
        expect(strings.t('orders'), isNotEmpty);
        expect(strings.t('account'), isNotEmpty);
        expect(strings.t('catalogue'), isNotEmpty);
        expect(strings.t('more'), isNotEmpty);
        expect(strings.t('payments'), isNotEmpty);
        expect(strings.t('overview'), isNotEmpty);
        expect(strings.t('moreMenuHint'), isNotEmpty);
        expect(strings.t('customerRole'), isNotEmpty);
      }
      expect(WingerStrings(const Locale('en')).t('catalogue'), 'Catalogue');
      expect(WingerStrings(const Locale('es')).t('catalogue'), 'Catálogo');
      expect(WingerStrings(const Locale('sw')).t('catalogue'), 'Katalogi');
    });
  });
}
