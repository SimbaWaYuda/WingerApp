import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:winger/core/l10n/winger_strings.dart';
import 'package:winger/core/models/models.dart';
import 'package:winger/core/widgets/kpi_card.dart';

/// Outer viewport widths for S2.6.20.76 admin KPI regression.
const _outerWidths = <double>[420, 768, 900, 1000, 1100, 1280];

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  List<KpiCardData> overviewKpis(WingerStrings s) => [
        KpiCardData(
          label: s.t('gmv'),
          value: '\$12500.00',
          delta: s.t('settlementUsd'),
        ),
        KpiCardData(
          label: s.t('wingerRevenue'),
          value: '\$890.50',
          delta: '\$72.70 ${s.t('settleable')}',
        ),
        KpiCardData(
          label: s.t('orders'),
          value: '42',
          delta: '30 ${s.t('paid')} · 12 ${s.t('open')}',
        ),
        KpiCardData(
          label: s.t('activeSuppliers'),
          value: '3',
          delta: '5 ${s.t('suppliers')}',
        ),
      ];

  List<KpiCardData> deliveryKpis(WingerStrings s) => [
        KpiCardData(
          label: s.t('inTransit'),
          value: '4',
          delta: '\$120.00',
        ),
        KpiCardData(
          label: s.t('pickupReady'),
          value: '2',
          delta: '\$48.00',
        ),
        KpiCardData(
          label: s.t('exceptions'),
          value: '1',
          delta: '\$15.00',
          positive: false,
        ),
      ];

  Future<void> pumpGrid(
    WidgetTester tester, {
    required double outerWidth,
    required Locale locale,
    required List<KpiCardData> data,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        locale: locale,
        localizationsDelegates: const [
          WingerStringsDelegate(),
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        supportedLocales: WingerStrings.supported,
        home: MediaQuery(
          data: MediaQueryData(size: Size(outerWidth, 900)),
          child: Scaffold(
            body: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (outerWidth >= 900) const SizedBox(width: 260),
                Expanded(
                  child: ListView(
                    padding: const EdgeInsets.all(20),
                    children: [
                      KpiCardGrid(
                        children: [
                          for (final kpi in data) KpiCard(data: kpi),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  void installOverflowGuard(List<String> overflows) {
    final previous = FlutterError.onError;
    FlutterError.onError = (details) {
      final message = details.exceptionAsString();
      if (message.contains('overflowed') || message.contains('OVERFLOWING')) {
        overflows.add(message);
      } else {
        previous?.call(details);
      }
    };
    addTearDown(() => FlutterError.onError = previous);
  }

  group('admin Overview KPI grid', () {
    for (final locale in WingerStrings.supported) {
      for (final width in _outerWidths) {
        testWidgets(
          '${locale.languageCode} @ ${width.toInt()}px — no overflow; GMV visible',
          (tester) async {
            final s = WingerStrings(locale);
            final gmv = s.t('gmv');
            final revenue = s.t('wingerRevenue');
            final overflows = <String>[];
            installOverflowGuard(overflows);

            await pumpGrid(
              tester,
              outerWidth: width,
              locale: locale,
              data: overviewKpis(s),
            );

            expect(overflows, isEmpty, reason: overflows.join('\n'));
            expect(find.text(gmv), findsOneWidget);
            expect(find.text(revenue), findsOneWidget);
            expect(find.text('\$12500.00'), findsOneWidget);
            expect(find.text('\$890.50'), findsOneWidget);
            expect(find.text('3'), findsOneWidget);
            // No horizontal overflow from a fixed-aspect GridView.
            expect(tester.takeException(), isNull);
          },
        );
      }
    }
  });

  group('admin Delivery KPI grid', () {
    for (final locale in WingerStrings.supported) {
      for (final width in _outerWidths) {
        testWidgets(
          '${locale.languageCode} @ ${width.toInt()}px — no overflow; transit labels visible',
          (tester) async {
            final s = WingerStrings(locale);
            final inTransit = s.t('inTransit');
            final pickup = s.t('pickupReady');
            final exceptions = s.t('exceptions');
            final overflows = <String>[];
            installOverflowGuard(overflows);

            await pumpGrid(
              tester,
              outerWidth: width,
              locale: locale,
              data: deliveryKpis(s),
            );

            expect(overflows, isEmpty, reason: overflows.join('\n'));
            expect(find.text(inTransit), findsOneWidget);
            expect(find.text(pickup), findsOneWidget);
            expect(find.text(exceptions), findsOneWidget);
            expect(find.text('4'), findsOneWidget);
            expect(find.text('\$120.00'), findsOneWidget);
          },
        );
      }
    }
  });
}
