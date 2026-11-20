import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:winger/core/api/api_client.dart';
import 'package:winger/core/payments/stripe_card_form.dart';
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

  group('checkout address API integration', () {
    late _ApiProbe probe;
    HttpOverrides? savedOverrides;

    setUp(() {
      savedOverrides = HttpOverrides.current;
      probe = _ApiProbe();
      _activeProbe = probe;
      HttpOverrides.global = _ProbeOverrides(probe);
    });

    tearDown(() {
      HttpOverrides.global = savedOverrides;
      _activeProbe = null;
    });

    test('validateCart posts the confirmed street and city', () async {
      final session = AppSession()..apiBaseUrl = probe.baseUrl;
      session.setConfirmedDeliveryAddress(
        cityName: '  Dar es Salaam  ',
        address: '  Tegeta  ',
      );
      session.setDeliveryMethod('express');
      await session.addToCart(_product(id: 'p1', supplierId: 's1'));
      final api = ApiClient(session);
      session.attachApi(api);
      session.accessToken = 't';
      session.apiOnline = true;

      await session.refreshCartFromServer();

      final body = probe.jsonBody('POST', '/orders/validate');
      expect(body['addressLine'], 'Tegeta');
      expect(body['city'], 'Dar es Salaam');
      expect(body['deliveryMethod'], 'express');
      expect(jsonEncode(body), isNot(contains('Westlands')));
      expect(jsonEncode(body), isNot(contains('Nairobi')));
    });

    test('validateCart uses session.addressLine when the argument is omitted', () async {
      final session = AppSession()..apiBaseUrl = probe.baseUrl;
      session.setConfirmedDeliveryAddress(
        cityName: 'Dar es Salaam',
        address: 'Tegeta',
      );
      await session.addToCart(_product(id: 'p1', supplierId: 's1'));
      final api = ApiClient(session);
      session.accessToken = 't';

      await api.validateCart(List.of(session.cart), city: session.city);

      final body = probe.jsonBody('POST', '/orders/validate');
      expect(body['addressLine'], 'Tegeta');
      expect(body['city'], 'Dar es Salaam');
    });

    test('createOrder posts the same confirmed address for card, Lipa and COD', () async {
      final session = AppSession()..apiBaseUrl = probe.baseUrl;
      session.setConfirmedDeliveryAddress(
        cityName: 'Dar es Salaam',
        address: 'Tegeta',
      );
      session.setDeliveryMethod('standard');
      final api = ApiClient(session);
      session.attachApi(api);
      session.accessToken = 't';
      session.apiOnline = true;

      for (final method in ['card', 'lipa', 'pay_on_delivery']) {
        probe.calls.clear();
        await session.addToCart(_product(id: 'p1', supplierId: 's1'));
        await session.placeOrder(paymentMethod: method);
        final body = probe.jsonBody('POST', '/orders');
        expect(body['addressLine'], 'Tegeta');
        expect(body['city'], 'Dar es Salaam');
        expect(body['deliveryMethod'], 'standard');
        expect(body['paymentMethod'], method);
        expect(jsonEncode(body), isNot(contains('Westlands')));
        expect(jsonEncode(body), isNot(contains('Nairobi')));
      }
    });

    test('pickup order posts an empty address instead of a fallback city', () async {
      final session = AppSession()..apiBaseUrl = probe.baseUrl;
      session.setDeliveryMethod('pickup');
      session.setConfirmedDeliveryAddress(cityName: '   ', address: '  ');
      await session.addToCart(_product(id: 'p1', supplierId: 's1'));
      final api = ApiClient(session);
      session.attachApi(api);
      session.accessToken = 't';
      session.apiOnline = true;

      await session.placeOrder(paymentMethod: 'card');

      final body = probe.jsonBody('POST', '/orders');
      expect(body['addressLine'], isEmpty);
      expect(body['city'], isEmpty);
      expect(body['deliveryMethod'], 'pickup');
      expect(jsonEncode(body), isNot(contains('Nairobi')));
      expect(jsonEncode(body), isNot(contains('Westlands')));
    });

    test('refreshProfile keeps a missing address empty', () async {
      final session = AppSession()..apiBaseUrl = probe.baseUrl;
      session.accessToken = 't';
      session.applyProfile(
        name: 'Amina',
        phoneNumber: '',
        cityName: 'Dar es Salaam',
        address: 'Tegeta',
      );
      probe.meBody = jsonEncode({
        'name': 'Amina',
        'phone': '',
        'city': null,
        'addressLine': '   ',
      });

      await ApiClient(session).refreshProfile();

      expect(session.city, isEmpty);
      expect(session.addressLine, isEmpty);
      expect(session.city.contains('Nairobi'), isFalse);
      expect(session.addressLine.contains('Westlands'), isFalse);
    });

    testWidgets('delivery address step rejects a blank street and city', (
      tester,
    ) async {
      final session = AppSession()..apiBaseUrl = probe.baseUrl;
      session.accessToken = 't';
      session.apiOnline = true;
      session.phone = '+255700000000';
      session.setDeliveryMethod('standard');

      await _pumpCheckout(tester, session);
      await tester.pump();
      final dynamic state = tester.state(find.byType(CheckoutScreen));
      state.setState(() => state.step = 1);
      await tester.pump();

      await tester.tap(find.widgetWithText(FilledButton, 'Continue'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.text('City and address are required.'), findsOneWidget);
      expect(state.step, 1);
      expect(
        probe.calls.where((call) => call.path == '/auth/profile'),
        isEmpty,
      );
    });

    testWidgets('blank pickup continues without writing the profile address', (
      tester,
    ) async {
      final session = AppSession()..apiBaseUrl = probe.baseUrl;
      session.accessToken = 't';
      session.apiOnline = true;
      session.phone = '+255700000000';
      session.setDeliveryMethod('pickup');
      session.setConfirmedDeliveryAddress(
        cityName: 'Dar es Salaam',
        address: 'Tegeta',
      );

      await _pumpCheckout(tester, session);
      await tester.pump();
      final dynamic state = tester.state(find.byType(CheckoutScreen));
      state.setState(() => state.step = 1);
      await tester.pump();
      await tester.enterText(find.byType(TextField).at(0), '   ');
      await tester.enterText(find.byType(TextField).at(1), ' \t ');
      await tester.pump();

      await tester.tap(find.widgetWithText(FilledButton, 'Continue'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(state.step, 2);
      expect(session.addressLine, isEmpty);
      expect(session.city, isEmpty);
      expect(
        probe.calls.where((call) => call.path == '/auth/profile'),
        isEmpty,
      );
    });

    testWidgets('pickup with an address stores the trimmed street and city', (
      tester,
    ) async {
      final session = AppSession()..apiBaseUrl = probe.baseUrl;
      session.accessToken = 't';
      session.apiOnline = true;
      session.phone = '+255700000000';
      session.setDeliveryMethod('pickup');

      await _pumpCheckout(tester, session);
      await tester.pump();
      final dynamic state = tester.state(find.byType(CheckoutScreen));
      state.setState(() => state.step = 1);
      await tester.pump();
      await tester.enterText(find.byType(TextField).at(0), '  Tegeta  ');
      await tester.enterText(find.byType(TextField).at(1), '  Dar es Salaam  ');
      await tester.pump();

      await tester.tap(find.widgetWithText(FilledButton, 'Continue'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(state.step, 2);
      expect(session.addressLine, 'Tegeta');
      expect(session.city, 'Dar es Salaam');
      final profile = probe.jsonBody('PATCH', '/auth/profile');
      expect(profile['addressLine'], 'Tegeta');
      expect(profile['city'], 'Dar es Salaam');
    });

    testWidgets('pay step rejects delivery before creating an order', (
      tester,
    ) async {
      final session = AppSession()..apiBaseUrl = probe.baseUrl;
      session.accessToken = 't';
      session.apiOnline = true;
      session.stripeCheckoutMode = 'test';
      session.stripePublishableKey = 'pk_test_address';
      session.setDeliveryMethod('standard');
      await session.addToCart(_product(id: 'p1', supplierId: 's1'));
      session.attachApi(ApiClient(session));

      await _pumpCheckout(tester, session);
      await tester.pump();
      final dynamic state = tester.state(find.byType(CheckoutScreen));
      state.setState(() => state.step = 3);
      await tester.pump();

      await tester.tap(find.widgetWithText(FilledButton, 'Payment'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.text('City and address are required.'), findsOneWidget);
      expect(
        probe.calls.where((call) => call.path == '/orders'),
        isEmpty,
      );
    });

    testWidgets('incomplete delivery street prevents createPaymentMethod', (
      tester,
    ) async {
      final counter = await _payWithIncompleteAddress(
        tester,
        address: '',
        city: 'Dar es Salaam',
      );
      expect(counter.calls, 0);
      expect(find.text('City and address are required.'), findsOneWidget);
      expect(probe.calls.where((call) => call.path == '/orders'), isEmpty);
    });

    testWidgets('incomplete delivery city prevents createPaymentMethod', (
      tester,
    ) async {
      final counter = await _payWithIncompleteAddress(
        tester,
        address: 'Tegeta',
        city: '',
      );
      expect(counter.calls, 0);
      expect(find.text('City and address are required.'), findsOneWidget);
      expect(probe.calls.where((call) => call.path == '/orders'), isEmpty);
    });

    testWidgets('Lipa rejects a missing street before order submission', (
      tester,
    ) async {
      await _rejectDeliveryPayChoice(
        tester,
        choice: 'Pay with Lipa',
        address: '',
        city: 'Dar es Salaam',
      );
      expect(find.text('City and address are required.'), findsOneWidget);
      expect(probe.calls.where((call) => call.path == '/orders'), isEmpty);
    });

    testWidgets('Lipa rejects a missing city before order submission', (
      tester,
    ) async {
      await _rejectDeliveryPayChoice(
        tester,
        choice: 'Pay with Lipa',
        address: 'Tegeta',
        city: '',
      );
      expect(find.text('City and address are required.'), findsOneWidget);
      expect(probe.calls.where((call) => call.path == '/orders'), isEmpty);
    });

    testWidgets(
      'pay on delivery rejects a missing street before order submission',
      (tester) async {
        await _rejectDeliveryPayChoice(
          tester,
          choice: 'Pay on delivery',
          address: '',
          city: 'Dar es Salaam',
        );
        expect(find.text('City and address are required.'), findsOneWidget);
        expect(probe.calls.where((call) => call.path == '/orders'), isEmpty);
      },
    );

    testWidgets(
      'pay on delivery rejects a missing city before order submission',
      (tester) async {
        await _rejectDeliveryPayChoice(
          tester,
          choice: 'Pay on delivery',
          address: 'Tegeta',
          city: '',
        );
        expect(find.text('City and address are required.'), findsOneWidget);
        expect(probe.calls.where((call) => call.path == '/orders'), isEmpty);
      },
    );

    testWidgets('pickup with a blank street keeps the supplied city', (
      tester,
    ) async {
      final session = await _continuePickupAddress(
        tester,
        address: '   ',
        city: '  Dar es Salaam  ',
      );
      expect(session.addressLine, isEmpty);
      expect(session.city, 'Dar es Salaam');
      expect(probe.calls.where((call) => call.path == '/auth/profile'), isEmpty);
    });

    testWidgets('pickup with a blank city keeps the supplied street', (
      tester,
    ) async {
      final session = await _continuePickupAddress(
        tester,
        address: '  Tegeta  ',
        city: ' \t ',
      );
      expect(session.addressLine, 'Tegeta');
      expect(session.city, isEmpty);
      expect(probe.calls.where((call) => call.path == '/auth/profile'), isEmpty);
    });

    testWidgets('delivery address step sends the trimmed profile update', (
      tester,
    ) async {
      final session = AppSession()..apiBaseUrl = probe.baseUrl;
      session.accessToken = 't';
      session.apiOnline = true;
      session.phone = '+255700000000';
      session.setDeliveryMethod('standard');

      await _pumpCheckout(tester, session);
      await tester.pump();
      final dynamic state = tester.state(find.byType(CheckoutScreen));
      state.setState(() => state.step = 1);
      await tester.pump();
      await tester.enterText(find.byType(TextField).at(0), '  Tegeta  ');
      await tester.enterText(find.byType(TextField).at(1), '  Dar es Salaam  ');
      await tester.pump();

      await tester.tap(find.widgetWithText(FilledButton, 'Continue'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(state.step, 2);
      expect(session.addressLine, 'Tegeta');
      expect(session.city, 'Dar es Salaam');
      final profile = probe.jsonBody('PATCH', '/auth/profile');
      expect(profile['addressLine'], 'Tegeta');
      expect(profile['city'], 'Dar es Salaam');
    });
  });
}

class _PaymentMethodCounter {
  int calls = 0;
  bool armed = false;
}

const _stripeChannel = MethodChannel('winger/stripe');

Future<void> _openPayStep(WidgetTester tester, AppSession session) async {
  await _pumpCheckout(tester, session);
  await tester.pump();
  await tester.pump();
  final dynamic state = tester.state(find.byType(CheckoutScreen));
  state.setState(() => state.step = 3);
  await tester.pump();
}

_PaymentMethodCounter _armCreatePaymentMethod(WidgetTester tester) {
  final counter = _PaymentMethodCounter();
  final hosted = find.byType(StripeCardForm);
  if (hosted.evaluate().isNotEmpty) {
    counter.armed = true;
    tester.widget<StripeCardForm>(hosted).handle.attach(() async {
      counter.calls += 1;
      throw StateError('createPaymentMethod was called');
    });
  }
  if (find.text('Card number').evaluate().isNotEmpty) {
    counter.armed = true;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      _stripeChannel,
      (call) async {
        counter.calls += 1;
        return 'pm_test_address';
      },
    );
    addTearDown(() {
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        _stripeChannel,
        null,
      );
    });
  }
  return counter;
}

Future<_PaymentMethodCounter> _payWithIncompleteAddress(
  WidgetTester tester, {
  required String address,
  required String city,
}) async {
  final session = AppSession()..apiBaseUrl = probeBaseUrl;
  session.accessToken = 't';
  session.apiOnline = true;
  session.stripeCheckoutMode = 'test';
  session.stripePublishableKey = 'pk_test_address';
  session.setDeliveryMethod('standard');
  session.setConfirmedDeliveryAddress(cityName: city, address: address);
  await session.addToCart(_product(id: 'p1', supplierId: 's1'));
  session.attachApi(ApiClient(session));
  _activeProbe?.fxConfigBody = jsonEncode({
    'settlementCurrency': 'USD',
    'supportedDisplayCurrencies': ['USD'],
    'supportedPaymentCurrencies': ['USD'],
    'stripeCheckoutMode': 'test',
    'stripePublishableKey': 'pk_test_address',
  });

  await _openPayStep(tester, session);
  // The hosted card form builds InAppWebView. Widget tests have no
  // InAppWebViewPlatform, so that build throws. The form state is still
  // mounted and initState has attached the handle the pay button calls.
  final firstWebViewError = tester.takeException();
  expect('$firstWebViewError', contains('InAppWebViewPlatform'));
  _drainInAppWebViewErrors(tester);
  final counter = _armCreatePaymentMethod(tester);
  expect(find.byType(StripeCardForm), findsOneWidget);
  expect(counter.armed, isTrue);
  await tester.tap(find.widgetWithText(FilledButton, 'Payment'));
  _drainInAppWebViewErrors(tester);
  await tester.pump();
  _drainInAppWebViewErrors(tester);
  await tester.pump(const Duration(milliseconds: 50));
  _drainInAppWebViewErrors(tester);
  return counter;
}

void _drainInAppWebViewErrors(WidgetTester tester) {
  while (true) {
    final error = tester.takeException();
    if (error == null) break;
    expect('$error', contains('InAppWebViewPlatform'));
  }
}

Future<void> _rejectDeliveryPayChoice(
  WidgetTester tester, {
  required String choice,
  required String address,
  required String city,
}) async {
  final session = AppSession()..apiBaseUrl = probeBaseUrl;
  session.accessToken = 't';
  session.apiOnline = true;
  session.setDeliveryMethod('standard');
  session.setConfirmedDeliveryAddress(cityName: city, address: address);
  await session.addToCart(_product(id: 'p1', supplierId: 's1'));
  session.attachApi(ApiClient(session));

  await _openPayStep(tester, session);
  expect(find.text(choice), findsWidgets);
  await tester.tap(find.text(choice).first);
  await tester.pump();
  await tester.tap(find.widgetWithText(FilledButton, 'Place order'));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
}

Future<AppSession> _continuePickupAddress(
  WidgetTester tester, {
  required String address,
  required String city,
}) async {
  final session = AppSession()..apiBaseUrl = probeBaseUrl;
  session.accessToken = 't';
  session.apiOnline = true;
  session.phone = '+255700000000';
  session.setDeliveryMethod('pickup');

  await _pumpCheckout(tester, session);
  await tester.pump();
  final dynamic state = tester.state(find.byType(CheckoutScreen));
  state.setState(() => state.step = 1);
  await tester.pump();
  await tester.enterText(find.byType(TextField).at(0), address);
  await tester.enterText(find.byType(TextField).at(1), city);
  await tester.pump();
  await tester.tap(find.widgetWithText(FilledButton, 'Continue'));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
  expect(state.step, 2);
  return session;
}

String get probeBaseUrl => _activeProbe?.baseUrl ?? 'http://127.0.0.1';

_ApiProbe? _activeProbe;

Future<void> _pumpCheckout(WidgetTester tester, AppSession session) async {
  final api = ApiClient(session);
  final router = GoRouter(
    initialLocation: '/customer/checkout',
    routes: [
      GoRoute(
        path: '/customer/checkout',
        builder: (context, state) => const Scaffold(body: CheckoutScreen()),
      ),
    ],
  );
  tester.view.physicalSize = const Size(390, 1200);
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

class _ApiCall {
  _ApiCall(this.method, this.path, this.body);

  final String method;
  final String path;
  final String body;
}

class _ApiProbe {
  final List<_ApiCall> calls = [];
  String meBody = '{"name":"Amina","phone":""}';
  String? fxConfigBody;

  String get baseUrl => 'http://127.0.0.1';

  String responseFor(Uri uri) {
    if (uri.path == '/fx/config' && fxConfigBody != null) {
      return fxConfigBody!;
    }
    return switch (uri.path) {
      '/auth/me' => meBody,
      '/orders' =>
        '{"id":"ord-1","displayId":"WG-100","total":40,"status":"PROCESSING","paymentStatus":"PENDING","items":[]}',
      '/orders/validate' =>
        '{"ok":true,"subtotal":40,"total":40,"deliveryFee":0,"tax":0,"deliveryMethod":"standard","lines":[],"shipments":[]}',
      '/supplier-payments/checkout' =>
        '{"suppliers":[{"supplierId":"s1","supplierName":"Savanna Electronics","merchantName":"Savanna","lipaOrTillNumber":"555000","network":"M_PESA"}]}',
      _ => '{}',
    };
  }

  Map<String, dynamic> jsonBody(String method, String path) {
    final call = calls.lastWhere(
      (entry) => entry.method == method && entry.path == path,
    );
    return jsonDecode(call.body) as Map<String, dynamic>;
  }
}

class _ProbeOverrides extends HttpOverrides {
  _ProbeOverrides(this.probe);

  final _ApiProbe probe;

  @override
  HttpClient createHttpClient(SecurityContext? context) {
    return _RecordingHttpClient(probe);
  }
}

class _RecordingHttpClient implements HttpClient {
  _RecordingHttpClient(this.probe);

  final _ApiProbe probe;

  @override
  Future<HttpClientRequest> openUrl(String method, Uri url) async {
    return _RecordingRequest(probe, method, url);
  }

  @override
  Future<HttpClientRequest> getUrl(Uri url) => openUrl('GET', url);

  @override
  Future<HttpClientRequest> postUrl(Uri url) => openUrl('POST', url);

  @override
  Future<HttpClientRequest> patchUrl(Uri url) => openUrl('PATCH', url);

  @override
  Future<HttpClientRequest> putUrl(Uri url) => openUrl('PUT', url);

  @override
  Future<HttpClientRequest> deleteUrl(Uri url) => openUrl('DELETE', url);

  @override
  Future<HttpClientRequest> headUrl(Uri url) => openUrl('HEAD', url);

  @override
  Future<HttpClientRequest> open(
    String method,
    String host,
    int port,
    String path,
  ) {
    return openUrl(method, Uri(host: host, port: port, path: path));
  }

  @override
  Future<HttpClientRequest> get(String host, int port, String path) =>
      open('GET', host, port, path);

  @override
  Future<HttpClientRequest> post(String host, int port, String path) =>
      open('POST', host, port, path);

  @override
  Future<HttpClientRequest> patch(String host, int port, String path) =>
      open('PATCH', host, port, path);

  @override
  Future<HttpClientRequest> put(String host, int port, String path) =>
      open('PUT', host, port, path);

  @override
  Future<HttpClientRequest> delete(String host, int port, String path) =>
      open('DELETE', host, port, path);

  @override
  Future<HttpClientRequest> head(String host, int port, String path) =>
      open('HEAD', host, port, path);

  @override
  void close({bool force = false}) {}

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _RecordingRequest implements HttpClientRequest {
  _RecordingRequest(this.probe, this.method, this.uri);

  final _ApiProbe probe;
  final List<int> _bytes = [];

  @override
  final String method;

  @override
  final Uri uri;

  @override
  final HttpHeaders headers = _ProbeHeaders();

  @override
  bool bufferOutput = true;

  @override
  int contentLength = -1;

  @override
  bool followRedirects = true;

  @override
  int maxRedirects = 5;

  @override
  bool persistentConnection = true;

  @override
  Encoding encoding = utf8;

  @override
  void add(List<int> data) => _bytes.addAll(data);

  @override
  Future<void> addStream(Stream<List<int>> stream) async {
    await for (final chunk in stream) {
      _bytes.addAll(chunk);
    }
  }

  @override
  Future<HttpClientResponse> close() async {
    probe.calls.add(_ApiCall(method, uri.path, utf8.decode(_bytes)));
    return _JsonResponse(probe.responseFor(uri));
  }

  @override
  void abort([Object? exception, StackTrace? stackTrace]) {}

  @override
  void addError(Object error, [StackTrace? stackTrace]) {}

  @override
  HttpConnectionInfo? get connectionInfo => null;

  @override
  List<Cookie> get cookies => const [];

  @override
  Future<HttpClientResponse> get done => close();

  @override
  Future<void> flush() async {}

  @override
  void write(Object? object) => add(utf8.encode(object.toString()));

  @override
  void writeAll(Iterable<dynamic> objects, [String separator = '']) {}

  @override
  void writeCharCode(int charCode) {}

  @override
  void writeln([Object? object = '']) {}
}

class _JsonResponse extends Stream<List<int>> implements HttpClientResponse {
  _JsonResponse(String body) : _bytes = utf8.encode(body);

  final List<int> _bytes;

  @override
  final HttpHeaders headers = _ProbeHeaders();

  @override
  int get statusCode => 200;

  @override
  int get contentLength => _bytes.length;

  @override
  bool get isRedirect => false;

  @override
  List<RedirectInfo> get redirects => const [];

  @override
  bool get persistentConnection => false;

  @override
  String get reasonPhrase => 'OK';

  @override
  HttpClientResponseCompressionState get compressionState =>
      HttpClientResponseCompressionState.decompressed;

  @override
  List<Cookie> get cookies => const [];

  @override
  X509Certificate? get certificate => null;

  @override
  HttpConnectionInfo? get connectionInfo => null;

  @override
  Future<Socket> detachSocket() => Future<Socket>.error(UnsupportedError('socket'));

  @override
  Future<HttpClientResponse> redirect([
    String? method,
    Uri? url,
    bool? followLoops,
  ]) {
    return Future<HttpClientResponse>.error(UnsupportedError('redirect'));
  }

  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int> event)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) {
    return Stream<List<int>>.value(_bytes).listen(
      onData,
      onError: onError,
      onDone: onDone,
      cancelOnError: cancelOnError,
    );
  }
}

class _ProbeHeaders implements HttpHeaders {
  @override
  List<String>? operator [](String name) => const [];

  @override
  void add(String name, Object value, {bool preserveHeaderCase = false}) {}

  @override
  bool chunkedTransferEncoding = false;

  @override
  void clear() {}

  @override
  int contentLength = -1;

  @override
  ContentType? contentType;

  @override
  DateTime? date;

  @override
  DateTime? expires;

  @override
  void forEach(void Function(String name, List<String> values) action) {}

  @override
  String? host;

  @override
  DateTime? ifModifiedSince;

  @override
  void noFolding(String name) {}

  @override
  bool persistentConnection = false;

  @override
  int? port;

  @override
  void remove(String name, Object value) {}

  @override
  void removeAll(String name) {}

  @override
  void set(String name, Object value, {bool preserveHeaderCase = false}) {}

  @override
  String? value(String name) => null;
}
