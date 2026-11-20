import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:winger/core/api/api_client.dart';
import 'package:winger/core/l10n/winger_strings.dart';
import 'package:winger/core/state/app_session.dart';
import 'package:winger/core/theme/winger_theme.dart';
import 'package:winger/features/customer/customer_screens.dart';

Widget _harness({
  required AppSession session,
  Locale locale = const Locale('en'),
  required Widget child,
}) {
  return MultiProvider(
    providers: [
      ChangeNotifierProvider.value(value: session),
      Provider(create: (_) => ApiClient(session)),
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
      home: Scaffold(body: child),
    ),
  );
}

/// Mirrors the currency-status branch used beside the home currency control.
class _FxStatusProbe extends StatelessWidget {
  const _FxStatusProbe();

  @override
  Widget build(BuildContext context) {
    final session = context.watch<AppSession>();
    final s = WingerStrings.of(context);
    if (session.fxError != null) {
      return Text(localisedFxStatusMessage(s, session.fxError));
    }
    return Text(
      session.showPaymentEstimate
          ? s
              .t('pricesShownPayIn')
              .replaceAll('{display}', session.displayCurrency)
              .replaceAll('{pay}', session.paymentCurrency)
          : s.t('youWillPayIn').replaceAll('{pay}', session.paymentCurrency),
    );
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('localisedFxStatusMessage', () {
    test('maps sentinel and sanitises technical payloads in EN ES SW', () {
      for (final locale in WingerStrings.supported) {
        final s = WingerStrings(locale);
        final expected = s.t('fxUnavailable');
        expect(localisedFxStatusMessage(s, 'fxUnavailable'), expected);
        expect(
          localisedFxStatusMessage(
            s,
            'ClientException: Failed to fetch, uri=http://localhost:3000/fx/config',
          ),
          expected,
        );
        expect(
          localisedFxStatusMessage(s, 'Exception: SocketException: Connection refused'),
          expected,
        );
        expect(localisedFxStatusMessage(s, 'raw-unknown-payload'), expected);
        expect(localisedFxStatusMessage(s, null), '');
      }
      expect(
        WingerStrings(const Locale('en')).t('fxUnavailable'),
        contains('Currency rates are unavailable'),
      );
      expect(
        WingerStrings(const Locale('es')).t('fxUnavailable'),
        contains('tasas de cambio'),
      );
      expect(
        WingerStrings(const Locale('sw')).t('fxUnavailable'),
        contains('Viola vya sarafu'),
      );
    });
  });

  group('currency status presentation', () {
    testWidgets('FX failure never shows ClientException or request URL', (
      tester,
    ) async {
      final session = AppSession();
      session.applyCurrencyQuote(
        settlement: 'USD',
        display: 'KES',
        rate: 1,
        fresh: false,
        error:
            'ClientException: Failed to fetch, uri=http://localhost:3000/fx/config',
      );

      await tester.pumpWidget(_harness(session: session, child: const _FxStatusProbe()));
      await tester.pump();

      expect(find.textContaining('ClientException'), findsNothing);
      expect(find.textContaining('localhost:3000'), findsNothing);
      expect(find.textContaining('fx/config'), findsNothing);
      expect(find.textContaining('uri='), findsNothing);
      expect(
        find.text(
          WingerStrings(const Locale('en')).t('fxUnavailable'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('FX failure localises to Spanish', (tester) async {
      final session = AppSession();
      session.applyCurrencyQuote(
        settlement: 'USD',
        display: 'USD',
        rate: 1,
        fresh: false,
        error: 'fxUnavailable',
      );

      await tester.pumpWidget(
        _harness(
          session: session,
          locale: const Locale('es'),
          child: const _FxStatusProbe(),
        ),
      );
      await tester.pump();

      expect(
        find.text(WingerStrings(const Locale('es')).t('fxUnavailable')),
        findsOneWidget,
      );
      expect(find.textContaining('ClientException'), findsNothing);
    });

    testWidgets('successful FX quote shows payment guidance not error', (
      tester,
    ) async {
      final session = AppSession();
      session.applyCurrencyQuote(
        settlement: 'USD',
        display: 'USD',
        rate: 1,
        fresh: true,
        displayOptions: const ['USD', 'TZS', 'KES', 'EUR'],
        paymentOptions: const ['USD', 'TZS'],
      );

      await tester.pumpWidget(_harness(session: session, child: const _FxStatusProbe()));
      await tester.pump();

      expect(find.textContaining('You will pay in USD'), findsOneWidget);
      expect(find.textContaining('unavailable'), findsNothing);
      expect(session.paymentCurrency, 'USD');
      expect(session.supportedDisplayCurrencies, containsAll(['USD', 'TZS']));
      expect(session.supportedPaymentCurrencies, ['USD', 'TZS']);
    });

    testWidgets('payment currency restriction unchanged when display is KES', (
      tester,
    ) async {
      final session = AppSession();
      session.applyCurrencyQuote(
        settlement: 'USD',
        display: 'KES',
        rate: 129.5,
        fresh: true,
        displayOptions: const ['USD', 'TZS', 'KES', 'EUR'],
        paymentOptions: const ['USD', 'TZS'],
      );

      await tester.pumpWidget(_harness(session: session, child: const _FxStatusProbe()));
      await tester.pump();

      expect(session.displayCurrency, 'KES');
      expect(session.paymentCurrency, 'USD');
      expect(session.showPaymentEstimate, isTrue);
      expect(find.textContaining('Prices shown in KES'), findsOneWidget);
      expect(find.textContaining('You will pay in USD'), findsOneWidget);
    });

    test('applyCurrencyQuote failure sentinel keeps options and marks stale', () {
      final session = AppSession();
      session.applyCurrencyQuote(
        settlement: 'USD',
        display: 'EUR',
        rate: 0.92,
        fresh: true,
        displayOptions: const ['USD', 'EUR', 'TZS'],
        paymentOptions: const ['USD', 'TZS'],
      );
      session.applyCurrencyQuote(
        settlement: session.settlementCurrency,
        display: session.displayCurrency,
        rate: 1,
        fresh: false,
        error: 'fxUnavailable',
      );

      expect(session.fxError, 'fxUnavailable');
      expect(session.fxFresh, isFalse);
      expect(session.supportedDisplayCurrencies, contains('EUR'));
      expect(session.paymentCurrency, 'USD');
      expect(session.formatMoney(10), 'USD 10.00');
    });
  });
}
