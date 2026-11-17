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

Product _product({
  required String id,
  required String name,
  required String supplierId,
  required String supplierName,
  double price = 40,
  String color = 'Graphite',
  String size = 'One size',
  int stock = 12,
}) {
  return Product(
    id: id,
    name: name,
    brand: 'Brand',
    category: 'Home',
    supplierId: supplierId,
    supplierName: supplierName,
    price: price,
    rating: 4.5,
    imageUrl: '',
    color: color,
    size: size,
    stock: stock,
  );
}

Future<void> _pumpHarness(
  WidgetTester tester, {
  required AppSession session,
  required String path,
  Locale locale = const Locale('en'),
  Size size = const Size(390, 900),
}) async {
  final api = ApiClient(session);
  final router = GoRouter(
    initialLocation: path,
    routes: [
      GoRoute(
        path: '/customer/cart',
        builder: (context, state) => const Scaffold(body: CartScreen()),
      ),
      GoRoute(
        path: '/customer/checkout',
        builder: (context, state) => const Scaffold(body: CheckoutScreen()),
      ),
      GoRoute(
        path: '/customer/search',
        builder: (context, state) => const Scaffold(body: Text('search-stub')),
      ),
      GoRoute(
        path: '/customer/orders',
        builder: (context, state) => const Scaffold(body: Text('orders-stub')),
      ),
    ],
  );

  final view = tester.view;
  view.physicalSize = size;
  view.devicePixelRatio = 1.0;
  addTearDown(view.resetPhysicalSize);
  addTearDown(view.resetDevicePixelRatio);

  await tester.pumpWidget(
    MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: session),
        Provider.value(value: api),
      ],
      child: MaterialApp.router(
        locale: locale,
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

void _setCheckoutStep(WidgetTester tester, int step) {
  final dynamic state = tester.state(find.byType(CheckoutScreen));
  state.setState(() {
    state.step = step;
  });
}

Future<void> _seedTwoSuppliers(AppSession session) async {
  await session.addToCart(
    _product(
      id: 'p1',
      name: 'Clay Mug',
      supplierId: 's1',
      supplierName: 'Kijani Goods',
      color: 'Terracotta',
      size: 'M',
    ),
    quantity: 2,
    variantColor: 'Terracotta',
    variantSize: 'M',
  );
  await session.addToCart(
    _product(
      id: 'p2',
      name: 'Cedar Tray',
      supplierId: 's2',
      supplierName: 'Coast Craft',
      price: 55,
    ),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('CartScreen', () {
    testWidgets('empty cart shows continue shopping', (tester) async {
      final session = AppSession();
      await _pumpHarness(tester, session: session, path: '/customer/cart');
      await tester.pumpAndSettle();

      expect(find.text('Your cart is empty'), findsOneWidget);
      expect(find.text('Continue shopping'), findsOneWidget);

      await tester.tap(find.text('Continue shopping'));
      await tester.pumpAndSettle();
      expect(find.text('search-stub'), findsOneWidget);
    });

    testWidgets('groups lines by supplier and shows variant', (tester) async {
      final session = AppSession();
      await _seedTwoSuppliers(session);
      await _pumpHarness(tester, session: session, path: '/customer/cart');
      await tester.pumpAndSettle();

      expect(find.text('Kijani Goods'), findsOneWidget);
      expect(find.text('Coast Craft'), findsOneWidget);
      expect(find.text('Clay Mug'), findsOneWidget);
      expect(find.text('Cedar Tray'), findsOneWidget);
      expect(find.text('Terracotta · M'), findsOneWidget);
      expect(find.text('Order summary'), findsOneWidget);
      expect(find.text('Checkout all products'), findsOneWidget);
    });

    testWidgets('quantity and remove actions update cart', (tester) async {
      final session = AppSession();
      await session.addToCart(
        _product(
          id: 'p1',
          name: 'Clay Mug',
          supplierId: 's1',
          supplierName: 'Kijani Goods',
        ),
        quantity: 2,
      );
      await _pumpHarness(tester, session: session, path: '/customer/cart');
      await tester.pumpAndSettle();

      expect(find.text('2'), findsWidgets);
      await tester.tap(find.byTooltip('Quantity').first);
      await tester.pumpAndSettle();
      expect(session.cart.single.quantity, 1);

      await tester.tap(find.byTooltip('Remove'));
      await tester.pumpAndSettle();
      expect(session.cart, isEmpty);
      expect(find.text('Your cart is empty'), findsOneWidget);
    });

    testWidgets('wide layout keeps order summary', (tester) async {
      final session = AppSession();
      await _seedTwoSuppliers(session);
      await _pumpHarness(
        tester,
        session: session,
        path: '/customer/cart',
        size: const Size(1440, 900),
      );
      await tester.pumpAndSettle();
      expect(find.text('Order summary'), findsOneWidget);
      expect(find.text('Kijani Goods'), findsOneWidget);
    });

    testWidgets('empty cart localises to Spanish', (tester) async {
      final session = AppSession();
      await _pumpHarness(
        tester,
        session: session,
        path: '/customer/cart',
        locale: const Locale('es'),
      );
      await tester.pumpAndSettle();
      expect(find.text('Tu carrito está vacío'), findsOneWidget);
      expect(find.text('Seguir comprando'), findsOneWidget);
    });

    testWidgets('fulfillment labels localise for express standard pickup',
        (tester) async {
      Future<void> expectMethod({
        required String method,
        required Locale locale,
        required String expected,
      }) async {
        final session = AppSession();
        session.setDeliveryMethod(method);
        await _seedTwoSuppliers(session);
        await _pumpHarness(
          tester,
          session: session,
          path: '/customer/cart',
          locale: locale,
        );
        await tester.pumpAndSettle();
        expect(find.textContaining(expected), findsOneWidget);
      }

      await expectMethod(
        method: 'standard',
        locale: const Locale('en'),
        expected: 'Standard 3–5 days',
      );
      await expectMethod(
        method: 'express',
        locale: const Locale('en'),
        expected: 'Express 1–2 days',
      );
      await expectMethod(
        method: 'pickup',
        locale: const Locale('en'),
        expected: 'Pickup',
      );
      await expectMethod(
        method: 'standard',
        locale: const Locale('es'),
        expected: 'Estándar 3–5 días',
      );
      await expectMethod(
        method: 'express',
        locale: const Locale('es'),
        expected: 'Express 1–2 días',
      );
      await expectMethod(
        method: 'pickup',
        locale: const Locale('es'),
        expected: 'Recoger',
      );
      await expectMethod(
        method: 'standard',
        locale: const Locale('sw'),
        expected: 'Kawaida siku 3–5',
      );
      await expectMethod(
        method: 'express',
        locale: const Locale('sw'),
        expected: 'Haraka siku 1–2',
      );
      await expectMethod(
        method: 'pickup',
        locale: const Locale('sw'),
        expected: 'Chukua',
      );
    });
  });

  group('CheckoutScreen', () {
    testWidgets('presents sequential steps and review summary', (tester) async {
      final session = AppSession();
      await _seedTwoSuppliers(session);
      await _pumpHarness(tester, session: session, path: '/customer/checkout');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.text('Checkout'), findsOneWidget);
      expect(find.text('Step 1 of 5'), findsOneWidget);
      expect(find.text('Review'), findsOneWidget);
      expect(find.text('Address'), findsOneWidget);
      expect(find.text('Delivery'), findsOneWidget);
      expect(find.text('Payment'), findsOneWidget);
      expect(find.text('Confirmation'), findsOneWidget);
      expect(find.textContaining('Kijani Goods'), findsWidgets);
      expect(find.textContaining('Coast Craft'), findsWidgets);
      expect(find.textContaining('Terracotta · M'), findsOneWidget);
    });

    testWidgets('delivery step shows pickup and multi-supplier note',
        (tester) async {
      final session = AppSession();
      await _seedTwoSuppliers(session);
      await _pumpHarness(tester, session: session, path: '/customer/checkout');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      _setCheckoutStep(tester, 2);
      await tester.pumpAndSettle();

      expect(find.text('Express 1–2 days'), findsOneWidget);
      expect(find.text('Standard 3–5 days'), findsOneWidget);
      expect(find.text('Pickup'), findsWidgets);
      expect(
        find.text(
          'Each supplier is quoted separately for delivery or pickup.',
        ),
        findsOneWidget,
      );
      expect(find.text('Kijani Goods'), findsWidgets);
      expect(find.text('Coast Craft'), findsWidgets);

      await tester.ensureVisible(
        find.byKey(const ValueKey('checkout-fulfill-pickup')),
      );
      await tester.tap(find.byKey(const ValueKey('checkout-fulfill-pickup')));
      await tester.pumpAndSettle();
      expect(session.deliveryMethod, 'pickup');
    });

    testWidgets('payment methods and currency label are presented',
        (tester) async {
      final session = AppSession();
      await _seedTwoSuppliers(session);
      await _pumpHarness(tester, session: session, path: '/customer/checkout');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      _setCheckoutStep(tester, 3);
      await tester.pumpAndSettle();

      expect(find.text('Payment method'), findsOneWidget);
      expect(find.textContaining('Payment currency:'), findsOneWidget);
      expect(find.text('Card'), findsOneWidget);
      expect(find.text('Pay on delivery'), findsOneWidget);

      await tester.tap(find.text('Pay on delivery'));
      await tester.pumpAndSettle();
      expect(find.textContaining('when the order arrives'), findsOneWidget);
    });

    testWidgets('payment failure stays unsuccessful and shows banner',
        (tester) async {
      final session = AppSession()..apiOnline = false;
      await _seedTwoSuppliers(session);
      await _pumpHarness(tester, session: session, path: '/customer/checkout');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      _setCheckoutStep(tester, 3);
      await tester.pumpAndSettle();

      await tester.tap(find.text('Pay on delivery'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Place order'));
      await tester.tap(find.text('Place order'));
      await tester.pumpAndSettle();

      expect(find.text('Payment needs attention'), findsOneWidget);
      expect(find.text('Payment recorded'), findsNothing);
      expect(find.text('Confirmation'), findsOneWidget);
      expect(session.lastOrder, isNull);
    });

    Future<void> pumpConfirmation(
      WidgetTester tester, {
      required CustomerOrder order,
    }) async {
      final session = AppSession();
      await _seedTwoSuppliers(session);
      session.lastOrder = order;
      await _pumpHarness(tester, session: session, path: '/customer/checkout');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      _setCheckoutStep(tester, 4);
      await tester.pumpAndSettle();
    }

    testWidgets('PAID shows payment success and order confirmed',
        (tester) async {
      await pumpConfirmation(
        tester,
        order: CustomerOrder(
          id: 'ord-paid',
          total: 100,
          status: OrderStatus.processing,
          shipments: const [],
          placedAt: DateTime(2026, 1, 1),
          paymentStatus: 'PAID',
          paymentMode: 'live',
          paymentMethod: 'card',
        ),
      );
      expect(find.text('Payment recorded'), findsOneWidget);
      expect(find.text('Order confirmed · ord-paid'), findsOneWidget);
      expect(find.text('Payment pending'), findsNothing);
      expect(find.text('Verifying payment'), findsNothing);
      expect(find.textContaining('Order received'), findsNothing);
    });

    testWidgets('PENDING shows pending not success or order confirmed',
        (tester) async {
      await pumpConfirmation(
        tester,
        order: CustomerOrder(
          id: 'ord-pending',
          total: 100,
          status: OrderStatus.processing,
          shipments: const [],
          placedAt: DateTime(2026, 1, 1),
          paymentStatus: 'PENDING',
          paymentMode: 'live',
          paymentMethod: 'card',
        ),
      );
      expect(find.text('Payment pending'), findsOneWidget);
      expect(
        find.textContaining('Payment confirmation is still outstanding'),
        findsOneWidget,
      );
      expect(find.text('Payment recorded'), findsNothing);
      expect(find.textContaining('Order confirmed'), findsNothing);
      expect(find.text('Order received · ord-pending'), findsOneWidget);
    });

    testWidgets('FAILED shows failed guidance without order confirmed',
        (tester) async {
      await pumpConfirmation(
        tester,
        order: CustomerOrder(
          id: 'ord-failed',
          total: 100,
          status: OrderStatus.processing,
          shipments: const [],
          placedAt: DateTime(2026, 1, 1),
          paymentStatus: 'FAILED',
          paymentMode: 'live',
          paymentMethod: 'card',
        ),
      );
      expect(find.text('Payment needs attention'), findsOneWidget);
      expect(find.textContaining('Payment was not completed'), findsOneWidget);
      expect(find.text('Payment recorded'), findsNothing);
      expect(find.textContaining('Order confirmed'), findsNothing);
      expect(find.text('Order received · ord-failed'), findsOneWidget);
    });

    testWidgets('REFUNDED and unknown statuses stay uncertain not success',
        (tester) async {
      await pumpConfirmation(
        tester,
        order: CustomerOrder(
          id: 'ord-refunded',
          total: 100,
          status: OrderStatus.processing,
          shipments: const [],
          placedAt: DateTime(2026, 1, 1),
          paymentStatus: 'REFUNDED',
          paymentMode: 'live',
          paymentMethod: 'card',
        ),
      );
      expect(find.text('Verifying payment'), findsOneWidget);
      expect(find.text('Payment recorded'), findsNothing);
      expect(find.textContaining('Order confirmed'), findsNothing);

      final session = AppSession();
      await _seedTwoSuppliers(session);
      session.lastOrder = CustomerOrder(
        id: 'ord-weird',
        total: 100,
        status: OrderStatus.processing,
        shipments: const [],
        placedAt: DateTime(2026, 1, 1),
        paymentStatus: 'SOMETHING_ELSE',
        paymentMode: 'demo',
        paymentMethod: 'card',
      );
      await _pumpHarness(tester, session: session, path: '/customer/checkout');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      _setCheckoutStep(tester, 4);
      await tester.pumpAndSettle();
      expect(find.text('Verifying payment'), findsOneWidget);
      expect(find.text('Payment recorded'), findsNothing);
      expect(find.textContaining('Order confirmed'), findsNothing);
    });

    testWidgets('COD PENDING shows pending banner and order received',
        (tester) async {
      await pumpConfirmation(
        tester,
        order: CustomerOrder(
          id: 'ord-cod',
          total: 100,
          status: OrderStatus.processing,
          shipments: const [],
          placedAt: DateTime(2026, 1, 1),
          paymentStatus: 'PENDING',
          paymentMode: 'cod',
          paymentMethod: 'pay_on_delivery',
          paymentCurrency: 'USD',
          paymentAmount: 100,
        ),
      );
      expect(find.text('Payment pending'), findsOneWidget);
      expect(find.textContaining('Pay'), findsWidgets);
      expect(find.text('Payment recorded'), findsNothing);
      expect(find.textContaining('Order confirmed'), findsNothing);
      expect(find.text('Order received · ord-cod'), findsOneWidget);
    });

    testWidgets('Lipa PENDING shows lipa banner and instructions',
        (tester) async {
      await pumpConfirmation(
        tester,
        order: CustomerOrder(
          id: 'ord-lipa',
          total: 100,
          status: OrderStatus.processing,
          shipments: const [],
          placedAt: DateTime(2026, 1, 1),
          paymentStatus: 'PENDING',
          paymentMode: 'lipa',
          paymentMethod: 'lipa',
          paymentCurrency: 'TZS',
          paymentAmount: 250000,
        ),
      );
      expect(find.text('Payment pending'), findsOneWidget);
      expect(
        find.textContaining('Lipa payment is still pending confirmation'),
        findsOneWidget,
      );
      expect(find.text('Payment recorded'), findsNothing);
      expect(find.textContaining('Order confirmed'), findsNothing);
      expect(find.text('Order received · ord-lipa'), findsOneWidget);
    });

    testWidgets('wide checkout keeps persistent summary', (tester) async {
      final session = AppSession();
      await _seedTwoSuppliers(session);
      await _pumpHarness(
        tester,
        session: session,
        path: '/customer/checkout',
        size: const Size(1440, 900),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(tester.getSize(find.byType(MaterialApp)).width, greaterThanOrEqualTo(1024));
      expect(find.text('Order summary'), findsOneWidget);
      expect(find.textContaining('Payment currency:'), findsOneWidget);
    });

    testWidgets('checkout step chrome localises to Swahili', (tester) async {
      final session = AppSession();
      await _seedTwoSuppliers(session);
      await _pumpHarness(
        tester,
        session: session,
        path: '/customer/checkout',
        locale: const Locale('sw'),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.textContaining('Hatua 1 kati ya 5'), findsOneWidget);
      expect(find.text('Kagua'), findsOneWidget);
      expect(find.text('Malipo'), findsOneWidget);
    });
  });
}
