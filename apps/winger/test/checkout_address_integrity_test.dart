import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:winger/core/api/api_client.dart';
import 'package:winger/core/l10n/winger_strings.dart';
import 'package:winger/core/models/models.dart';
import 'package:winger/core/state/app_session.dart';
import 'package:winger/core/theme/winger_theme.dart';
import 'package:winger/features/customer/customer_screens.dart';

/// Counts order creation without performing an HTTP request.
class _OrderRequestCounter extends ApiClient {
  _OrderRequestCounter(super.session);

  int createOrderCalls = 0;

  @override
  Future<CustomerOrder> createOrder({
    required List<CartItem> items,
    String paymentMethod = 'card',
    required String addressLine,
    required String city,
    String? deliveryMethod,
    String? stripePaymentMethodId,
    String? checkoutIdempotencyKey,
    String? phone,
  }) {
    createOrderCalls += 1;
    throw StateError('createOrder was called');
  }
}

_OrderRequestCounter _watchOrders(AppSession session, {required bool apiOnline}) {
  final api = _OrderRequestCounter(session);
  session.attachApi(api);
  session.accessToken = 't';
  session.apiOnline = apiOnline;
  return api;
}

Product _product({required String id, required String supplierId}) {
  return Product(
    id: id,
    name: 'SoundFold Mini Speaker',
    brand: 'Savanna',
    category: 'Electronics',
    supplierId: supplierId,
    supplierName: 'Savanna Electronics',
    price: 40,
    rating: 4.5,
    imageUrl: '',
    color: 'Sand',
    size: 'Compact',
    stock: 8,
  );
}

void main() {
  group('DEF-ADDR-01 session address integrity', () {
    test('defaults are empty — Tegeta is never replaced by Westlands/Nairobi', () {
      final session = AppSession();
      expect(session.city, isEmpty);
      expect(session.addressLine, isEmpty);

      session.applyProfile(
        name: 'Amina Mwangi',
        phoneNumber: '+255700000000',
        cityName: 'Dar es Salaam',
        address: 'Tegeta',
      );
      expect(session.city, 'Dar es Salaam');
      expect(session.addressLine, 'Tegeta');
      expect(session.hasConfirmedDeliveryAddress, isTrue);
    });

    test('null/blank profile fields stay unset after applyProfile', () {
      final session = AppSession();
      session.applyProfile(
        name: 'Amina',
        phoneNumber: '',
        cityName: 'Dar es Salaam',
        address: 'Tegeta',
      );
      session.applyProfile(
        name: 'Amina',
        phoneNumber: '',
        cityName: '',
        address: '',
      );
      expect(session.city, isEmpty);
      expect(session.addressLine, isEmpty);
      expect(session.hasConfirmedDeliveryAddress, isFalse);
    });

    test('sign-out clears address instead of restoring Westlands/Nairobi', () {
      final session = AppSession();
      session.applyAuth(
        token: 't',
        id: 'u1',
        name: 'Amina',
        mail: 'a@example.com',
        selectedRole: UserRole.customer,
        cityName: 'Dar es Salaam',
        address: 'Tegeta',
      );
      session.signOut();
      expect(session.city, isEmpty);
      expect(session.addressLine, isEmpty);
    });

    test('placeOrder requires confirmed address for delivery (all pay methods)', () async {
      final session = AppSession();
      await session.addToCart(_product(id: 'p1', supplierId: 's1'));
      session.setDeliveryMethod('standard');
      session.apiOnline = true;

      for (final method in ['card', 'pay_on_delivery', 'lipa']) {
        await expectLater(
          session.placeOrder(paymentMethod: method),
          throwsA(
            isA<Exception>().having(
              (e) => e.toString(),
              'message',
              contains('Address and city are required for delivery'),
            ),
          ),
        );
      }
    });

    test('confirmed address stores the trimmed street and city', () {
      final session = AppSession();
      session.setConfirmedDeliveryAddress(
        cityName: '  Dar es Salaam  ',
        address: '  Tegeta  ',
      );
      expect(session.addressLine, 'Tegeta');
      expect(session.city, 'Dar es Salaam');
      expect(session.addressLine, isNot(contains(' ')));
      expect(session.hasConfirmedDeliveryAddress, isTrue);
      expect(session.addressLine.contains('Westlands'), isFalse);
      expect(session.city.contains('Nairobi'), isFalse);
    });

    test('delivery with a blank street is rejected before any order request', () async {
      final session = AppSession();
      await session.addToCart(_product(id: 'p1', supplierId: 's1'));
      session.setDeliveryMethod('standard');
      session.setConfirmedDeliveryAddress(
        cityName: 'Dar es Salaam',
        address: '   ',
      );
      final orders = _watchOrders(session, apiOnline: true);

      await expectLater(
        session.placeOrder(paymentMethod: 'card'),
        throwsA(
          isA<Exception>().having(
            (e) => e.toString(),
            'message',
            contains('Address and city are required for delivery'),
          ),
        ),
      );
      expect(orders.createOrderCalls, 0);
      expect(session.cart, hasLength(1));
      expect(session.lastOrder, isNull);
    });

    test('delivery with a blank city is rejected before any order request', () async {
      final session = AppSession();
      await session.addToCart(_product(id: 'p1', supplierId: 's1'));
      session.setDeliveryMethod('express');
      session.setConfirmedDeliveryAddress(
        cityName: ' \t ',
        address: 'Tegeta',
      );
      final orders = _watchOrders(session, apiOnline: true);

      await expectLater(
        session.placeOrder(paymentMethod: 'lipa'),
        throwsA(
          isA<Exception>().having(
            (e) => e.toString(),
            'message',
            contains('Address and city are required for delivery'),
          ),
        ),
      );
      expect(orders.createOrderCalls, 0);
      expect(session.cart, hasLength(1));
      expect(session.lastOrder, isNull);
    });

    test('pickup with whitespace-only address reaches the online gate', () async {
      final session = AppSession();
      await session.addToCart(_product(id: 'p1', supplierId: 's1'));
      session.setDeliveryMethod('pickup');
      session.setConfirmedDeliveryAddress(cityName: '   ', address: '  ');
      final orders = _watchOrders(session, apiOnline: false);

      await expectLater(
        session.placeOrder(paymentMethod: 'card'),
        throwsA(
          isA<Exception>().having(
            (e) => e.toString(),
            'message',
            contains('Checkout needs an online connection'),
          ),
        ),
      );
      expect(session.addressLine, isEmpty);
      expect(session.city, isEmpty);
      expect(orders.createOrderCalls, 0);
      expect(session.cart, hasLength(1));
      expect(session.lastOrder, isNull);
    });

    test('pickup does not require street address before online gate', () async {
      final session = AppSession();
      await session.addToCart(_product(id: 'p1', supplierId: 's1'));
      session.setDeliveryMethod('pickup');
      session.apiOnline = false;
      await expectLater(
        session.placeOrder(paymentMethod: 'card'),
        throwsA(
          isA<Exception>().having(
            (e) => e.toString(),
            'message',
            contains('online connection'),
          ),
        ),
      );
    });

    test('confirmed address is shared across summary fields and placeOrder inputs', () {
      final session = AppSession();
      session.setConfirmedDeliveryAddress(
        cityName: 'Dar es Salaam',
        address: 'Tegeta',
      );
      expect(session.city, 'Dar es Salaam');
      expect(session.addressLine, 'Tegeta');
      final summary =
          '${session.addressLine}, ${session.city}';
      expect(summary, 'Tegeta, Dar es Salaam');
      expect(summary.contains('Westlands'), isFalse);
      expect(summary.contains('Nairobi'), isFalse);
    });

    test('multi-supplier cart keeps one shared confirmed destination', () async {
      final session = AppSession();
      await session.addToCart(_product(id: 'p1', supplierId: 's1'));
      await session.addToCart(
        _product(id: 'p2', supplierId: 's2'),
        variantColor: 'Blue',
        variantSize: 'L',
      );
      expect(session.cart.length, 2);
      expect(session.cart.map((e) => e.product.supplierId).toSet().length, 2);
      session.setConfirmedDeliveryAddress(
        cityName: 'Dar es Salaam',
        address: 'Tegeta',
      );
      expect(session.addressLine, 'Tegeta');
      expect(session.city, 'Dar es Salaam');
    });

    test('add-to-cart without address uses local fee estimate only', () async {
      final session = AppSession();
      expect(session.hasConfirmedDeliveryAddress, isFalse);
      await session.addToCart(_product(id: 'p1', supplierId: 's1'));
      expect(session.cart.length, 1);
      expect(session.cartFeesAreLocalEstimate, isTrue);
      expect(session.cartDeliveryFee, greaterThan(0));
      expect(session.deliveryEstimateFor(''), '3–5 days');
      expect(session.deliveryEstimateFor(''), isNot(contains('Nairobi')));
    });

    test('checkout still requires confirmed delivery address', () async {
      final session = AppSession();
      await session.addToCart(_product(id: 'p1', supplierId: 's1'));
      expect(session.cartFeesAreLocalEstimate, isTrue);
      session.apiOnline = true;
      await expectLater(
        session.placeOrder(paymentMethod: 'card'),
        throwsA(
          isA<Exception>().having(
            (e) => e.toString(),
            'message',
            contains('Address and city are required for delivery'),
          ),
        ),
      );
      // Local estimate never authorises order creation — API path requires address.
      expect(session.cart.isNotEmpty, isTrue);
    });
  });

  group('M1.2 local fee estimate presentation', () {
    testWidgets('cart summary labels local fees as estimate', (tester) async {
      final session = AppSession();
      await session.addToCart(_product(id: 'p1', supplierId: 's1'));
      expect(session.cartFeesAreLocalEstimate, isTrue);

      final api = ApiClient(session);
      final router = GoRouter(
        initialLocation: '/customer/cart',
        routes: [
          GoRoute(
            path: '/customer/cart',
            builder: (context, state) => const Scaffold(body: CartScreen()),
          ),
        ],
      );
      tester.view.physicalSize = const Size(390, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider.value(value: session),
            Provider.value(value: api),
          ],
          child: MaterialApp.router(
            theme: WingerTheme.light(),
            supportedLocales: WingerStrings.supported,
            localizationsDelegates: const [
              WingerStringsDelegate(),
              GlobalMaterialLocalizations.delegate,
              GlobalWidgetsLocalizations.delegate,
              GlobalCupertinoLocalizations.delegate,
            ],
            routerConfig: router,
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.text('Delivery (estimate)'), findsWidgets);
      expect(
        find.textContaining(
          'Temporary estimate until you confirm your address',
        ),
        findsOneWidget,
      );
    });
  });

  group('DEF-ADDR-01 checkout navigation keeps confirmed address', () {
    Future<void> pumpCheckout(WidgetTester tester, AppSession session) async {
      final api = ApiClient(session);
      final router = GoRouter(
        initialLocation: '/customer/checkout',
        routes: [
          GoRoute(
            path: '/customer/checkout',
            builder: (context, state) =>
                const Scaffold(body: CheckoutScreen()),
          ),
        ],
      );
      tester.view.physicalSize = const Size(390, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider.value(value: session),
            Provider.value(value: api),
          ],
          child: MaterialApp.router(
            theme: WingerTheme.light(),
            supportedLocales: WingerStrings.supported,
            localizationsDelegates: const [
              WingerStringsDelegate(),
              GlobalMaterialLocalizations.delegate,
              GlobalWidgetsLocalizations.delegate,
              GlobalCupertinoLocalizations.delegate,
            ],
            routerConfig: router,
          ),
        ),
      );
    }

    testWidgets('returning to address step shows confirmed Tegeta / Dar', (
      tester,
    ) async {
      final session = AppSession();
      session.applyAuth(
        token: 't',
        id: 'u1',
        name: 'Amina Mwangi',
        mail: 'amina@example.com',
        selectedRole: UserRole.customer,
      );
      session.setConfirmedDeliveryAddress(
        cityName: 'Dar es Salaam',
        address: 'Tegeta',
      );
      await session.addToCart(_product(id: 'p1', supplierId: 's1'));

      await pumpCheckout(tester, session);
      await tester.pumpAndSettle();

      // Jump to fulfillment (step 2) then back to address (step 1).
      final dynamic state = tester.state(find.byType(CheckoutScreen));
      state.setState(() => state.step = 2);
      await tester.pumpAndSettle();
      expect(session.addressLine, 'Tegeta');
      expect(session.city, 'Dar es Salaam');

      state.setState(() => state.step = 1);
      await tester.pumpAndSettle();

      // Confirmed session destination survives step navigation (no silent Westlands/Nairobi).
      expect(session.addressLine, 'Tegeta');
      expect(session.city, 'Dar es Salaam');
      expect(session.hasConfirmedDeliveryAddress, isTrue);
    });
  });
}
