import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:winger/core/api/api_client.dart';
import 'package:winger/core/l10n/winger_strings.dart';
import 'package:winger/core/offline/offline_database.dart';
import 'package:winger/core/offline/sync_engine.dart';
import 'package:winger/core/repositories/catalog_repository.dart';
import 'package:winger/core/state/app_session.dart';
import 'package:winger/core/theme/winger_theme.dart';
import 'package:winger/features/customer/customer_screens.dart';

/// S2.6.20.92 — Compare empty-state copy must not reuse searchHint.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  WingerStrings s(String code) => WingerStrings(Locale(code));

  const searchHintEn = 'Describe what you want, or search a name';
  const searchHintEs = 'Describe lo que buscas, o escribe un nombre';
  const searchHintSw = 'Eleza unachotaka, au tafuta jina';

  const compareEmptyEn =
      'No products to compare yet. Add products to compare their features side by side.';
  const compareEmptyEs =
      'Aún no hay productos para comparar. Añade productos para comparar sus características lado a lado.';
  const compareEmptySw =
      'Bado hakuna bidhaa za kulinganisha. Ongeza bidhaa ili kulinganisha sifa zake bega kwa bega.';

  group('compareEmpty localisation', () {
    test('EN ES SW resolve to comparison-specific copy', () {
      expect(s('en').t('compareEmpty'), compareEmptyEn);
      expect(s('es').t('compareEmpty'), compareEmptyEs);
      expect(s('sw').t('compareEmpty'), compareEmptySw);
    });

    test('compareEmpty is distinct from searchHint in every locale', () {
      for (final locale in WingerStrings.supported) {
        final strings = WingerStrings(locale);
        final empty = strings.t('compareEmpty');
        final hint = strings.t('searchHint');
        expect(empty, isNotEmpty, reason: '$locale compareEmpty');
        expect(empty, isNot(equals('compareEmpty')));
        expect(empty, isNot(equals(hint)), reason: '$locale must not reuse searchHint');
      }
    });

    test('searchHint remains unchanged in EN ES SW', () {
      expect(s('en').t('searchHint'), searchHintEn);
      expect(s('es').t('searchHint'), searchHintEs);
      expect(s('sw').t('searchHint'), searchHintSw);
    });
  });

  group('compare selection limit', () {
    test('toggleCompare and addToCompare still cap at three products', () {
      final session = AppSession();
      expect(session.toggleCompare('a'), isTrue);
      expect(session.toggleCompare('b'), isTrue);
      expect(session.toggleCompare('c'), isTrue);
      expect(session.compareIds, ['a', 'b', 'c']);
      expect(session.toggleCompare('d'), isFalse);
      expect(session.compareIds, ['a', 'b', 'c']);

      session.clearCompare();
      expect(session.addToCompare(['p1', 'p2', 'p3', 'p4']), 3);
      expect(session.compareIds, ['p1', 'p2', 'p3']);
      expect(session.addToCompare(['p5']), 0);
      expect(session.compareIds.length, 3);
    });
  });

  group('CompareScreen empty state', () {
    Future<void> pumpCompare(
      WidgetTester tester, {
      required AppSession session,
      Locale locale = const Locale('en'),
    }) async {
      final api = ApiClient(session);
      final db = OfflineDatabase();
      final sync = SyncEngine(db: db, session: session);
      final catalog = CatalogRepository(db: db, api: api, syncEngine: sync);

      final view = tester.view;
      view.physicalSize = const Size(1100, 900);
      view.devicePixelRatio = 1.0;
      addTearDown(view.resetPhysicalSize);
      addTearDown(view.resetDevicePixelRatio);

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider.value(value: session),
            Provider.value(value: api),
            Provider.value(value: catalog),
          ],
          child: MaterialApp(
            locale: locale,
            theme: WingerTheme.light(),
            supportedLocales: WingerStrings.supported,
            localizationsDelegates: const [
              WingerStringsDelegate(),
              GlobalMaterialLocalizations.delegate,
              GlobalWidgetsLocalizations.delegate,
              GlobalCupertinoLocalizations.delegate,
            ],
            home: const Scaffold(body: CompareScreen()),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('empty Compare shows compareEmpty, not searchHint (EN)', (
      tester,
    ) async {
      final session = AppSession();
      expect(session.compareIds, isEmpty);

      await pumpCompare(tester, session: session);

      expect(find.text('Compare'), findsOneWidget);
      expect(find.text(compareEmptyEn), findsOneWidget);
      expect(find.text(searchHintEn), findsNothing);
    });

    testWidgets('empty Compare localises in ES and SW', (tester) async {
      await pumpCompare(
        tester,
        session: AppSession(),
        locale: const Locale('es'),
      );
      expect(find.text(compareEmptyEs), findsOneWidget);
      expect(find.text(searchHintEs), findsNothing);

      await pumpCompare(
        tester,
        session: AppSession(),
        locale: const Locale('sw'),
      );
      expect(find.text(compareEmptySw), findsOneWidget);
      expect(find.text(searchHintSw), findsNothing);
    });
  });
}
