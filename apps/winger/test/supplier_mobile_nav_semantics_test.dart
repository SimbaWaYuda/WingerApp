import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:winger/core/api/api_client.dart';
import 'package:winger/core/l10n/winger_strings.dart';
import 'package:winger/core/models/models.dart';
import 'package:winger/core/state/app_session.dart';
import 'package:winger/core/theme/winger_theme.dart';
import 'package:winger/core/widgets/role_shell.dart';
import 'package:winger/features/supplier/supplier_screens.dart';

Future<void> _pumpSupplierMobileShell(
  WidgetTester tester, {
  required String location,
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
  final api = ApiClient(session);
  final dest = supplierMobileDestinations();
  final router = GoRouter(
    initialLocation: location,
    routes: [
      ShellRoute(
        builder: (context, state, child) => RoleShell(
          title: supplierShellTitle(WingerStrings.of(context), state.uri.path),
          roleLabel: 'Supplier',
          layoutKind: ShellLayoutKind.operations,
          destinations: dest,
          mobileDestinations: dest,
          child: child,
        ),
        routes: [
          GoRoute(
            path: '/supplier',
            builder: (context, state) => const Text('overview-body'),
          ),
          GoRoute(
            path: '/supplier/orders',
            builder: (context, state) => const Text('orders-body'),
          ),
          GoRoute(
            path: '/supplier/products',
            builder: (context, state) => const Text('catalogue-body'),
          ),
          GoRoute(
            path: '/supplier/more',
            builder: (context, state) => const SupplierMoreScreen(),
          ),
          GoRoute(
            path: '/supplier/returns',
            builder: (context, state) => const Text('returns-body'),
          ),
          GoRoute(
            path: '/supplier/delivery',
            builder: (context, state) => const Text('delivery-body'),
          ),
          GoRoute(
            path: '/supplier/payments',
            builder: (context, state) => const Text('payments-body'),
          ),
        ],
      ),
    ],
  );

  final view = tester.view;
  // Compact enough for bottom nav (< 900) but wide enough to avoid
  // pre-existing top-bar overflow at very narrow widths.
  view.physicalSize = const Size(700, 900);
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
  await tester.pumpAndSettle();
}

List<SemanticsNode> _bottomNavNodes(WidgetTester tester, WingerStrings s) {
  final labels = [
    s.t('overview'),
    s.t('orders'),
    s.t('catalogue'),
    s.t('more'),
  ];
  final bar = find.byKey(const ValueKey('role-shell-bottom-nav'));
  return [
    for (final label in labels)
      tester.getSemantics(
        find.descendant(of: bar, matching: find.bySemanticsLabel(label)),
      ),
  ];
}

int _selectedCount(List<SemanticsNode> nodes) {
  return nodes.where((n) => n.hasFlag(SemanticsFlag.isSelected)).length;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final s = WingerStrings(const Locale('en'));

  group('supplierMoreDestinationSelected', () {
    test('matches payments delivery returns and nested paths', () {
      expect(
        supplierMoreDestinationSelected('/supplier/payments', '/supplier/payments'),
        isTrue,
      );
      expect(
        supplierMoreDestinationSelected('/supplier/delivery', '/supplier/delivery'),
        isTrue,
      );
      expect(
        supplierMoreDestinationSelected('/supplier/returns', '/supplier/returns'),
        isTrue,
      );
      expect(
        supplierMoreDestinationSelected('/supplier/returns/x', '/supplier/returns'),
        isTrue,
      );
      expect(
        supplierMoreDestinationSelected('/supplier/more', '/supplier/payments'),
        isFalse,
      );
    });
  });

  group('bottom navigation semantics', () {
    for (final entry in [
      ('/supplier', 'overview'),
      ('/supplier/orders', 'orders'),
      ('/supplier/products', 'catalogue'),
      ('/supplier/more', 'more'),
      ('/supplier/returns', 'more'),
      ('/supplier/delivery', 'more'),
      ('/supplier/payments', 'more'),
    ]) {
      testWidgets(
        '${entry.$1} exposes exactly one selected bottom destination (${entry.$2})',
        (tester) async {
          await _pumpSupplierMobileShell(tester, location: entry.$1);
          final nodes = _bottomNavNodes(tester, s);
          expect(_selectedCount(nodes), 1);

          final expectedLabel = s.t(entry.$2);
          final selected = nodes.singleWhere(
            (n) => n.hasFlag(SemanticsFlag.isSelected),
          );
          expect(selected.label, expectedLabel);

          // No duplicated accessible name from Semantics + Text.
          expect(selected.label, isNot(contains('$expectedLabel $expectedLabel')));
        },
      );
    }
  });

  group('More hub semantics', () {
    testWidgets(
      'on /supplier/more no destination tile is selected; actions are not selected',
      (tester) async {
        await _pumpSupplierMobileShell(tester, location: '/supplier/more');

        for (final label in [s.t('payments'), s.t('deliveryFees'), s.t('returns')]) {
          final node = tester.getSemantics(find.text(label).first);
          expect(
            node.hasFlag(SemanticsFlag.isSelected),
            isFalse,
            reason: '$label should not be selected on More hub',
          );
        }

        expect(
          tester.getSemantics(find.text(s.t('account'))).hasFlag(SemanticsFlag.isSelected),
          isFalse,
        );
        expect(
          tester.getSemantics(find.text(s.languageLabel)).hasFlag(SemanticsFlag.isSelected),
          isFalse,
        );
        expect(
          tester.getSemantics(find.text(s.t('signOut'))).hasFlag(SemanticsFlag.isSelected),
          isFalse,
        );
      },
    );

    testWidgets('returns route selects Returns only in More hub when opened', (
      tester,
    ) async {
      // More hub is not on returns body; pump More screen with returns location
      // via a dedicated shell child to inspect ListTile selection.
      final session = AppSession()
        ..applyAuth(
          token: 't',
          id: 'u1',
          name: 'John Doe',
          mail: 'supplier@kijani.example',
          selectedRole: UserRole.supplier,
          supplier: 's-kijani',
        );
      final api = ApiClient(session);
      final router = GoRouter(
        initialLocation: '/supplier/returns',
        routes: [
          GoRoute(
            path: '/supplier/returns',
            builder: (context, state) => const Scaffold(
              body: SupplierMoreScreen(),
            ),
          ),
          GoRoute(
            path: '/supplier/delivery',
            builder: (context, state) => const Scaffold(
              body: SupplierMoreScreen(),
            ),
          ),
          GoRoute(
            path: '/supplier/payments',
            builder: (context, state) => const Scaffold(
              body: SupplierMoreScreen(),
            ),
          ),
          GoRoute(path: '/login', builder: (context, state) => const SizedBox()),
        ],
      );

      final view = tester.view;
      view.physicalSize = const Size(390, 844);
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
      await tester.pumpAndSettle();

      final returnsNode = tester.getSemantics(find.text(s.t('returns')).first);
      final paymentsNode = tester.getSemantics(find.text(s.t('payments')).first);
      final deliveryNode =
          tester.getSemantics(find.text(s.t('deliveryFees')).first);

      expect(returnsNode.hasFlag(SemanticsFlag.isSelected), isTrue);
      expect(paymentsNode.hasFlag(SemanticsFlag.isSelected), isFalse);
      expect(deliveryNode.hasFlag(SemanticsFlag.isSelected), isFalse);
      expect(
        tester.getSemantics(find.text(s.t('account'))).hasFlag(SemanticsFlag.isSelected),
        isFalse,
      );
      expect(
        tester.getSemantics(find.text(s.t('signOut'))).hasFlag(SemanticsFlag.isSelected),
        isFalse,
      );
    });
  });
}
