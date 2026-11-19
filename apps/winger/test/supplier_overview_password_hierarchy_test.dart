import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:winger/core/analytics/analytics.dart';
import 'package:winger/core/api/api_client.dart';
import 'package:winger/core/l10n/winger_strings.dart';
import 'package:winger/core/models/models.dart';
import 'package:winger/core/state/app_session.dart';
import 'package:winger/core/theme/winger_theme.dart';
import 'package:winger/core/widgets/kpi_card.dart';
import 'package:winger/features/auth/password_cards.dart';
import 'package:winger/features/supplier/supplier_screens.dart';

Map<String, dynamic> _dashboardPayload() => {
      'grossSales': 18535,
      'orderLineCount': 84,
      'openLines': 23,
      'shippedLines': 10,
      'settleableCommission': 72.7,
      'productCount': 7,
      'lowStockCount': 1,
      'openReturns': 0,
      'supplierName': 'Kijani Tech',
    };

Future<void> _pumpOverview(
  WidgetTester tester, {
  required Size viewport,
}) async {
  final session = AppSession()
    ..applyAuth(
      token: 't',
      id: 'u1',
      name: 'John Doe',
      mail: 'supplier@kijani.example',
      selectedRole: UserRole.supplier,
      supplier: 's-kijani',
    );
  // Keep onboarding checklist offline so it does not call the API.
  session.setApiOnline(false);

  final api = ApiClient(session);
  final router = GoRouter(
    initialLocation: '/supplier',
    routes: [
      GoRoute(
        path: '/supplier',
        builder: (context, state) => Scaffold(
          body: SupplierDashboardScreen(
            dashboardLoader: () async => _dashboardPayload(),
          ),
        ),
      ),
      GoRoute(
        path: '/supplier/delivery',
        builder: (context, state) => const SizedBox(),
      ),
      GoRoute(
        path: '/supplier/returns',
        builder: (context, state) => const SizedBox(),
      ),
      GoRoute(
        path: '/supplier/orders',
        builder: (context, state) => const SizedBox(),
      ),
      GoRoute(
        path: '/supplier/products',
        builder: (context, state) => const SizedBox(),
      ),
      GoRoute(
        path: '/supplier/payments',
        builder: (context, state) => const SizedBox(),
      ),
      GoRoute(path: '/login', builder: (context, state) => const SizedBox()),
    ],
  );

  final view = tester.view;
  view.physicalSize = viewport;
  view.devicePixelRatio = 1.0;
  addTearDown(view.resetPhysicalSize);
  addTearDown(view.resetDevicePixelRatio);

  await tester.pumpWidget(
    MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: session),
        Provider.value(value: api),
        Provider(create: (_) => Analytics(api)),
      ],
      child: MaterialApp.router(
        locale: const Locale('en'),
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
  // Avoid pumpAndSettle — ChipScrollRow / checklist can keep the frame busy.
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final s = WingerStrings(const Locale('en'));

  for (final width in [390.0, 1280.0]) {
    testWidgets(
      'Overview at ${width.toInt()}px shows KPIs before voluntary password',
      (tester) async {
        await _pumpOverview(tester, viewport: Size(width, 900));

        expect(find.byType(KpiCard), findsWidgets);
        expect(
          find.byKey(const ValueKey('supplier-voluntary-password')),
          findsOneWidget,
        );
        // Collapsed by default — full card does not dominate.
        expect(find.byType(ChangePasswordCard), findsNothing);

        final kpiTop = tester.getTopLeft(find.byType(KpiCard).first).dy;
        final passwordTop = tester
            .getTopLeft(find.byKey(const ValueKey('supplier-voluntary-password')))
            .dy;
        expect(kpiTop < passwordTop, isTrue);

        // No overflow on KPI / compact action.
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets('voluntary password action expands to ChangePasswordCard', (
    tester,
  ) async {
    await _pumpOverview(tester, viewport: const Size(700, 900));

    await tester.ensureVisible(
      find.byKey(const ValueKey('supplier-voluntary-password')),
    );
    await tester.tap(find.byKey(const ValueKey('supplier-voluntary-password')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.byType(ChangePasswordCard), findsOneWidget);
    expect(find.text(s.t('currentPassword')), findsOneWidget);
    expect(find.text(s.t('newPassword')), findsOneWidget);
  });
}
