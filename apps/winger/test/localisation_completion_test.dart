import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:winger/core/l10n/winger_strings.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  WingerStrings s(String code) => WingerStrings(Locale(code));

  group('compare bar and table strings', () {
    test('comparingProducts interpolates count in EN ES SW', () {
      expect(
        s('en').t('comparingProducts').replaceAll('{count}', '3'),
        'Comparing 3 products',
      );
      expect(
        s('es').t('comparingProducts').replaceAll('{count}', '3'),
        'Comparando 3 productos',
      );
      expect(
        s('sw').t('comparingProducts').replaceAll('{count}', '3'),
        'Unalinganisha bidhaa 3',
      );
    });

    test('compare fulfillment and stock labels localise', () {
      for (final locale in WingerStrings.supported) {
        final strings = WingerStrings(locale);
        expect(strings.t('fulfillExpress'), isNotEmpty);
        expect(strings.t('fulfillStandard'), isNotEmpty);
        expect(strings.t('fulfillPickup'), isNotEmpty);
        expect(strings.t('inStock'), isNotEmpty);
        expect(strings.t('lowStock'), isNotEmpty);
        expect(strings.t('outOfStock'), isNotEmpty);
        expect(strings.t('fulfillMethod'), isNotEmpty);
      }
      expect(s('en').t('fulfillStandard'), 'Standard 3–5 days');
      expect(s('es').t('fulfillStandard'), 'Estándar 3–5 días');
      expect(s('sw').t('fulfillStandard'), 'Kawaida siku 3–5');
    });
  });

  group('product detail delivery estimates', () {
    test('estimate keys interpolate city in EN ES SW', () {
      expect(
        s('en').t('estimateExpressTo').replaceAll('{city}', 'Nairobi'),
        '1–2 days to Nairobi',
      );
      expect(
        s('es').t('estimateStandardTo').replaceAll('{city}', 'Nairobi'),
        '3–5 días a Nairobi',
      );
      expect(
        s('sw').t('estimatePickupIn').replaceAll('{city}', 'Nairobi'),
        'Tayari kuchukuliwa katika Nairobi',
      );
      expect(s('en').t('fulfillExpress'), 'Express 1–2 days');
      expect(s('es').t('fulfillPickup'), 'Recoger');
      expect(s('sw').t('fulfillExpress'), 'Haraka siku 1–2');
    });
  });

  group('tooltips and checkout hints', () {
    test('scroll tooltips localise', () {
      expect(s('en').t('scrollLeft'), 'Scroll left');
      expect(s('en').t('scrollRight'), 'Scroll right');
      expect(s('es').t('scrollLeft'), 'Desplazar a la izquierda');
      expect(s('es').t('scrollRight'), 'Desplazar a la derecha');
      expect(s('sw').t('scrollLeft'), 'Sogeza kushoto');
      expect(s('sw').t('scrollRight'), 'Sogeza kulia');
    });

    test('address and card expiry hints localise', () {
      expect(s('en').t('addressExampleHint'), 'Westlands');
      expect(s('es').t('addressExampleHint'), 'Westlands');
      expect(s('sw').t('addressExampleHint'), 'Westlands');
      expect(s('en').t('cardExpiryHint'), 'MM/YY');
      expect(s('es').t('cardExpiryHint'), 'MM/AA');
      expect(s('sw').t('cardExpiryHint'), 'MM/YY');
    });
  });

  group('customer and supplier navigation', () {
    test('customer nav keys resolve in EN ES SW', () {
      const keys = [
        'home',
        'search',
        'cart',
        'orders',
        'account',
        'wishlist',
        'compare',
        'clearFilters',
        'profileSaved',
        'orderNotFound',
        'cityAddressRequired',
      ];
      for (final locale in WingerStrings.supported) {
        final strings = WingerStrings(locale);
        for (final key in keys) {
          expect(strings.t(key), isNotEmpty, reason: '$locale $key');
        }
      }
      expect(s('es').t('profileSaved'), 'Perfil guardado');
      expect(s('sw').t('orderNotFound'), 'Oda haijapatikana');
    });

    test('supplier screen keys resolve in EN ES SW', () {
      const keys = [
        'overview',
        'orders',
        'catalogue',
        'more',
        'payments',
        'noPaidOrdersYet',
        'allNetworks',
        'otherNetwork',
        'stockReceivedSynced',
        'stockReceivedQueued',
        'variantEditorHint',
        'colourHexLabel',
        'moreMenuHint',
      ];
      for (final locale in WingerStrings.supported) {
        final strings = WingerStrings(locale);
        for (final key in keys) {
          final value = strings.t(key);
          expect(value, isNotEmpty, reason: '$locale $key');
          expect(value, isNot(equals(key)), reason: 'missing $locale $key');
        }
      }
      expect(
        s('en').t('noPaidOrdersYet'),
        'No paid orders for your catalogue yet.',
      );
      expect(
        s('es').t('noPaidOrdersYet'),
        'Aún no hay pedidos pagados de tu catálogo.',
      );
      expect(
        s('sw').t('allNetworks'),
        'Mitandao yote',
      );
      expect(
        s('en')
            .t('stockReceivedSynced')
            .replaceAll('{qty}', '20')
            .replaceAll('{name}', 'Chair')
            .replaceAll('{stock}', '40'),
        'Received +20 for Chair · stock 40 · synced',
      );
    });
  });

  group('representative empty and loading copy', () {
    test('customer empty and cart strings localise', () {
      expect(s('en').t('wishlistEmpty'), 'No saved products yet.');
      expect(s('es').t('wishlistEmpty'), 'Aún no hay productos guardados.');
      expect(s('sw').t('wishlistEmpty'), 'Bado hakuna bidhaa zilizohifadhiwa.');
      expect(s('en').t('noProducts'), isNotEmpty);
      expect(s('es').t('noProducts'), isNotEmpty);
      expect(s('sw').t('noProducts'), isNotEmpty);
    });
  });
}
