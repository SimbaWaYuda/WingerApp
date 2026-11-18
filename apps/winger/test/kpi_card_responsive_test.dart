import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:winger/core/l10n/winger_strings.dart';
import 'package:winger/core/models/models.dart';
import 'package:winger/core/widgets/kpi_card.dart';

/// Outer viewport widths from S2.6.20.69 / S2.6.20.70.
const _outerWidths = <double>[420, 900, 1000, 1100, 1280];

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  List<KpiCardData> overviewKpis(WingerStrings s) => [
        KpiCardData(
          label: s.t('grossSales'),
          value: '\$18535',
          delta: '84 ${s.t('lines')}',
        ),
        KpiCardData(
          label: s.t('openLines'),
          value: '23',
          delta: '10 ${s.t('shipped')}',
        ),
        KpiCardData(
          label: s.t('settleableCommission'),
          value: '\$72.70',
          delta: s.t('settleable'),
        ),
        KpiCardData(
          label: s.t('products'),
          value: '7',
          delta: '1 ${s.t('lowStock')}',
          positive: false,
        ),
        KpiCardData(
          label: s.t('openReturns'),
          value: '0',
          delta: s.t('returnsNeedsReview'),
        ),
      ];

  List<KpiCardData> returnsKpis(WingerStrings s) => [
        KpiCardData(
          label: s.t('returnsOpen'),
          value: '0',
          delta: s.t('needsReview'),
        ),
        KpiCardData(
          label: s.t('refundsPending'),
          value: '0',
          delta: s.t('awaitingRefund'),
        ),
        KpiCardData(
          label: s.t('refundsIssued'),
          value: '8',
          delta: s.t('markedIssued'),
        ),
        KpiCardData(
          label: s.t('returnsRejected'),
          value: '3',
          delta: s.t('returnsClosed'),
        ),
      ];

  List<KpiCardData> paymentsKpis(WingerStrings s) => [
        KpiCardData(
          label: s.t('activeRate'),
          value: '10.0%',
          delta: s.t('commission'),
        ),
        KpiCardData(
          label: s.t('commissionWaiting'),
          value: '\$12.00',
          delta: s.t('notPaidOut'),
        ),
        KpiCardData(
          label: s.t('cashStaysInWinger'),
          value: '\$5.00',
          delta: s.t('notSentToStripe'),
        ),
        KpiCardData(
          label: s.t('payoutsAlreadySent'),
          value: '\$0.00',
          delta: s.t('acceptedByStripe'),
        ),
        KpiCardData(
          label: s.t('recognizedCommission'),
          value: '\$20.00',
          delta: s.t('recognized'),
        ),
        KpiCardData(
          label: s.t('pendingCommission'),
          value: '\$3.00',
          delta: s.t('pending'),
        ),
      ];

  Future<void> pumpGrid(
    WidgetTester tester, {
    required double outerWidth,
    required Locale locale,
    required List<KpiCardData> data,
    double spacing = 12,
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
                // Mirrors RoleShell side nav consuming width when wide.
                if (outerWidth >= 900) const SizedBox(width: 260),
                Expanded(
                  child: ListView(
                    padding: const EdgeInsets.all(20),
                    children: [
                      KpiCardGrid(
                        spacing: spacing,
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

  void installOverflowGuard(
    WidgetTester tester,
    List<String> overflows,
  ) {
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

  group('supplier Overview KPI grid', () {
    for (final locale in WingerStrings.supported) {
      for (final width in _outerWidths) {
        testWidgets(
          '${locale.languageCode} @ ${width.toInt()}px — no overflow; settleable visible',
          (tester) async {
            final s = WingerStrings(locale);
            final settleable = s.t('settleableCommission');
            final overflows = <String>[];
            installOverflowGuard(tester, overflows);

            await pumpGrid(
              tester,
              outerWidth: width,
              locale: locale,
              data: overviewKpis(s),
            );

            expect(overflows, isEmpty, reason: overflows.join('\n'));
            expect(find.text(settleable), findsOneWidget);
            expect(find.text('\$72.70'), findsOneWidget);
            expect(find.text('\$18535'), findsOneWidget);
          },
        );
      }
    }
  });

  group('supplier Returns KPI grid', () {
    for (final locale in WingerStrings.supported) {
      for (final width in _outerWidths) {
        testWidgets(
          '${locale.languageCode} @ ${width.toInt()}px — no overflow; pending refunds visible',
          (tester) async {
            final s = WingerStrings(locale);
            final pending = s.t('refundsPending');
            final awaiting = s.t('awaitingRefund');
            final overflows = <String>[];
            installOverflowGuard(tester, overflows);

            await pumpGrid(
              tester,
              outerWidth: width,
              locale: locale,
              data: returnsKpis(s),
              spacing: 10,
            );

            expect(overflows, isEmpty, reason: overflows.join('\n'));
            expect(find.text(pending), findsOneWidget);
            expect(find.text(awaiting), findsOneWidget);
          },
        );
      }
    }
  });

  group('supplier Payments KPI grid', () {
    for (final locale in WingerStrings.supported) {
      for (final width in _outerWidths) {
        testWidgets(
          '${locale.languageCode} @ ${width.toInt()}px — no overflow; long labels visible',
          (tester) async {
            final s = WingerStrings(locale);
            final cash = s.t('cashStaysInWinger');
            final waiting = s.t('commissionWaiting');
            final overflows = <String>[];
            installOverflowGuard(tester, overflows);

            await pumpGrid(
              tester,
              outerWidth: width,
              locale: locale,
              data: paymentsKpis(s),
            );

            expect(overflows, isEmpty, reason: overflows.join('\n'));
            expect(find.text(cash), findsOneWidget);
            final pendingLabel = s.t('pendingCommission');
            expect(waiting, isNot(equals(pendingLabel)));
            expect(find.text(waiting), findsOneWidget);
            expect(find.text(pendingLabel), findsOneWidget);
            expect(find.text('\$12.00'), findsOneWidget);
            expect(find.text('\$3.00'), findsOneWidget);
          },
        );
      }
    }
  });
}
