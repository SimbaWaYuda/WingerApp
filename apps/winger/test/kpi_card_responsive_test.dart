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
    bool balanceFourCardLayout = false,
    double minCardWidth = 168,
  }) async {
    final view = tester.view;
    view.physicalSize = Size(outerWidth, 900);
    view.devicePixelRatio = 1.0;
    addTearDown(view.resetPhysicalSize);
    addTearDown(view.resetDevicePixelRatio);

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
        home: Scaffold(
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
                      minCardWidth: minCardWidth,
                      balanceFourCardLayout: balanceFourCardLayout,
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
    );
    await tester.pumpAndSettle();
  }

  double contentWidthFor(double outerWidth) {
    final side = outerWidth >= 900 ? 260.0 : 0.0;
    return outerWidth - side - 40; // ListView padding 20*2
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

  group('kpiCardColumnCount balanceFourCardLayout', () {
    test('avoids 3 columns for four cards; prefers 2 or 4', () {
      // Content width that would naturally choose 3 columns with min 168 / spacing 10.
      const spacing = 10.0;
      const minW = 168.0;
      // natural 3 when (maxW+10)/(178) in [3,4) → maxW in [524, 702)
      const midContent = 600.0;
      expect(
        kpiCardColumnCount(
          maxWidth: midContent,
          childCount: 4,
          minCardWidth: minW,
          spacing: spacing,
          balanceFourCardLayout: false,
        ),
        3,
      );
      expect(
        kpiCardColumnCount(
          maxWidth: midContent,
          childCount: 4,
          minCardWidth: minW,
          spacing: spacing,
          balanceFourCardLayout: true,
        ),
        2,
      );
      expect(
        kpiCardColumnCount(
          maxWidth: 720,
          childCount: 4,
          minCardWidth: minW,
          spacing: spacing,
          balanceFourCardLayout: true,
        ),
        4,
      );
    });
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
              balanceFourCardLayout: true,
            );

            expect(overflows, isEmpty, reason: overflows.join('\n'));
            expect(find.text(pending), findsOneWidget);
            expect(find.text(awaiting), findsOneWidget);

            final contentW = contentWidthFor(width);
            final cols = kpiCardColumnCount(
              maxWidth: contentW,
              childCount: 4,
              minCardWidth: 168,
              spacing: 10,
              balanceFourCardLayout: true,
            );
            expect(cols == 1 || cols == 2 || cols == 4, isTrue);
            expect(cols, isNot(3), reason: 'Rejected must not sit alone in 3+1');

            final cards = find.byType(KpiCard);
            expect(cards, findsNWidgets(4));
            final tops = [
              for (var i = 0; i < 4; i++) tester.getTopLeft(cards.at(i)).dy,
            ];
            if (cols == 4) {
              expect(tops[0], tops[1]);
              expect(tops[0], tops[2]);
              expect(tops[0], tops[3]);
            } else if (cols == 2) {
              expect(tops[0], tops[1]);
              expect(tops[2], tops[3]);
              expect(tops[0] == tops[2], isFalse);
            }
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
