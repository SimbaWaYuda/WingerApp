import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:winger/core/api/api_client.dart';
import 'package:winger/core/l10n/winger_strings.dart';
import 'package:winger/core/state/app_session.dart';
import 'package:winger/core/theme/winger_theme.dart';
import 'package:winger/core/widgets/role_shell.dart';

Future<void> _pumpShell(
  WidgetTester tester, {
  required AppSession session,
  Locale locale = const Locale('en'),
  Size size = const Size(1100, 900),
}) async {
  final api = ApiClient(session);
  final router = GoRouter(
    initialLocation: '/ops',
    routes: [
      GoRoute(
        path: '/ops',
        builder: (context, state) => RoleShell(
          title: 'Dashboard',
          roleLabel: 'Ops',
          layoutKind: ShellLayoutKind.operations,
          destinations: const [
            ShellDestination(
              labelKey: 'overview',
              icon: Icons.dashboard_outlined,
              path: '/ops',
            ),
          ],
          child: const Center(child: Text('ops-body')),
        ),
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
  await tester.pumpAndSettle();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('pendingSync localisation', () {
    test('EN ES SW pendingSync and hint are distinct from apiStatus', () {
      final en = WingerStrings(const Locale('en'));
      final es = WingerStrings(const Locale('es'));
      final sw = WingerStrings(const Locale('sw'));

      expect(en.t('pendingSync'), 'Pending sync');
      expect(es.t('pendingSync'), 'Sincronización pendiente');
      expect(sw.t('pendingSync'), 'Usawazishaji unasubiri');

      expect(en.t('pendingSyncHint'), 'Local changes awaiting synchronisation');
      expect(
        es.t('pendingSyncHint'),
        'Cambios locales en espera de sincronización',
      );
      expect(
        sw.t('pendingSyncHint'),
        'Mabadiliko ya ndani yanasubiri usawazishaji',
      );

      for (final s in [en, es, sw]) {
        expect(s.t('pendingSync'), isNot(equals(s.t('apiStatus'))));
        expect(s.t('apiStatus'), 'API');
      }
    });
  });

  group('operations top-bar pending-sync chip', () {
    testWidgets('shows Pending sync · n when count > 0 (EN)', (tester) async {
      final session = AppSession()
        ..setApiOnline(true)
        ..setPendingSyncCount(3);
      await _pumpShell(tester, session: session);

      expect(find.text('Pending sync · 3'), findsOneWidget);
      expect(find.text('API: Online'), findsOneWidget);
      expect(find.text('API 3'), findsNothing);
      expect(find.textContaining(RegExp(r'^API \d+$')), findsNothing);

      final semantics = tester.getSemantics(find.text('Pending sync · 3'));
      expect(
        semantics.label,
        contains('Local changes awaiting synchronisation'),
      );
      expect(semantics.label, contains('3'));
    });

    testWidgets('hides chip when pendingSyncCount is 0', (tester) async {
      final session = AppSession()
        ..setApiOnline(true)
        ..setPendingSyncCount(0);
      await _pumpShell(tester, session: session);

      expect(find.textContaining('Pending sync'), findsNothing);
      expect(find.text('API: Online'), findsOneWidget);
    });

    testWidgets('ES and SW show localised pending-sync chip', (tester) async {
      for (final entry in [
        (const Locale('es'), 'Sincronización pendiente · 2', 'API: En línea'),
        (const Locale('sw'), 'Usawazishaji unasubiri · 2', 'API: Mtandaoni'),
      ]) {
        final session = AppSession()
          ..setApiOnline(true)
          ..setPendingSyncCount(2);
        await _pumpShell(tester, session: session, locale: entry.$1);

        expect(find.text(entry.$2), findsOneWidget);
        expect(find.text(entry.$3), findsOneWidget);
        expect(find.text('API 2'), findsNothing);
      }
    });

    testWidgets('API offline label stays separate from pending sync', (
      tester,
    ) async {
      final session = AppSession()
        ..setApiOnline(false)
        ..setPendingSyncCount(1);
      await _pumpShell(tester, session: session);

      expect(find.text('Pending sync · 1'), findsOneWidget);
      expect(find.text('API: Offline (using demo data)'), findsOneWidget);
      expect(find.text('API 1'), findsNothing);
    });
  });
}
