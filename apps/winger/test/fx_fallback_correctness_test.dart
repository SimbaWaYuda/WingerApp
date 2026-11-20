import 'dart:convert';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:winger/core/api/api_client.dart';
import 'package:winger/core/l10n/winger_strings.dart';
import 'package:winger/core/state/app_session.dart';
import 'package:winger/features/customer/customer_screens.dart';

Map<String, dynamic> _config({
  String settlement = 'USD',
  List<String> display = const ['USD', 'TZS', 'KES', 'EUR'],
  List<String> payment = const ['USD', 'TZS'],
}) {
  return {
    'settlementCurrency': settlement,
    'supportedDisplayCurrencies': display,
    'supportedPaymentCurrencies': payment,
    'stripeCheckoutMode': 'demo',
  };
}

Map<String, dynamic> _quote({
  required String from,
  required String to,
  Object? rate = 2500,
  bool fresh = true,
}) {
  return {
    'baseCurrency': from,
    'quoteCurrency': to,
    'rate': rate,
    'source': 'test',
    'fetchedAt': '2026-01-01T00:00:00.000Z',
    'expiresAt': '2026-12-31T00:00:00.000Z',
    'fresh': fresh,
  };
}

void _seedFreshCrossCurrency(AppSession session) {
  session.preferredDisplayCurrency = 'TZS';
  session.applyCurrencyQuote(
    settlement: 'USD',
    display: 'TZS',
    rate: 2500,
    fresh: true,
    displayOptions: const ['USD', 'TZS', 'KES', 'EUR'],
    paymentOptions: const ['USD', 'TZS'],
  );
}

ApiClient _client(
  AppSession session,
  Future<http.Response> Function(http.Request) handler,
) {
  session.apiBaseUrl = 'http://fx.test';
  return ApiClient(session, httpClient: MockClient(handler));
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('parsePositiveFiniteFxRate', () {
    test('accepts positive finite rates only', () {
      expect(parsePositiveFiniteFxRate(1), 1);
      expect(parsePositiveFiniteFxRate(2500.5), 2500.5);
      expect(parsePositiveFiniteFxRate(null), isNull);
      expect(parsePositiveFiniteFxRate('1'), isNull);
      expect(parsePositiveFiniteFxRate(0), isNull);
      expect(parsePositiveFiniteFxRate(-2), isNull);
      expect(parsePositiveFiniteFxRate(double.nan), isNull);
      expect(parsePositiveFiniteFxRate(double.infinity), isNull);
      expect(parsePositiveFiniteFxRate(double.negativeInfinity), isNull);
    });
  });

  group('refreshCurrencyQuote correctness', () {
    test('config HTTP non-200 after fresh cross-currency marks unavailable',
        () async {
      final session = AppSession();
      _seedFreshCrossCurrency(session);
      final api = _client(session, (request) async {
        expect(request.url.path, '/fx/config');
        return http.Response('nope', 503);
      });

      await api.refreshCurrencyQuote();

      expect(session.fxFresh, isFalse);
      expect(session.fxError, 'fxUnavailable');
      expect(session.displayCurrency, 'USD');
      expect(session.preferredDisplayCurrency, 'TZS');
      expect(session.formatMoney(10), 'USD 10.00');
      expect(session.formatMoney(10), isNot(contains('TZS')));
      expect(session.paymentCurrency, 'USD');
    });

    test('config transport failure after fresh quote marks unavailable',
        () async {
      final session = AppSession();
      _seedFreshCrossCurrency(session);
      final api = _client(session, (request) async {
        throw http.ClientException(
          'Failed to fetch',
          Uri.parse('http://fx.test/fx/config'),
        );
      });

      await api.refreshCurrencyQuote();

      expect(session.fxFresh, isFalse);
      expect(session.fxError, 'fxUnavailable');
      expect(session.displayCurrency, 'USD');
      expect(session.preferredDisplayCurrency, 'TZS');
      expect(session.formatMoney(10), 'USD 10.00');
    });

    test('successful quote with missing rate is not marked fresh', () async {
      final session = AppSession();
      session.preferredDisplayCurrency = 'TZS';
      final api = _client(session, (request) async {
        if (request.url.path.endsWith('/fx/config')) {
          return http.Response(jsonEncode(_config()), 200);
        }
        final body = _quote(from: 'USD', to: 'TZS')..remove('rate');
        return http.Response(jsonEncode(body), 200);
      });

      await api.refreshCurrencyQuote();

      expect(session.fxFresh, isFalse);
      expect(session.fxError, 'fxUnavailable');
      expect(session.displayCurrency, 'USD');
      expect(session.formatMoney(10), 'USD 10.00');
    });

    test('invalid JSON-representable rates are rejected', () async {
      for (final rate in <Object?>[null, 'x', 0, -1]) {
        final session = AppSession();
        session.preferredDisplayCurrency = 'TZS';
        final api = _client(session, (request) async {
          if (request.url.path.endsWith('/fx/config')) {
            return http.Response(jsonEncode(_config()), 200);
          }
          return http.Response(
            jsonEncode(_quote(from: 'USD', to: 'TZS', rate: rate)),
            200,
          );
        });

        await api.refreshCurrencyQuote();

        expect(session.fxFresh, isFalse, reason: 'rate=$rate');
        expect(session.fxError, 'fxUnavailable', reason: 'rate=$rate');
        expect(session.formatMoney(10), 'USD 10.00', reason: 'rate=$rate');
      }
    });

    test('NaN and infinite rates cannot be marked fresh', () {
      for (final rate in <double>[
        double.nan,
        double.infinity,
        double.negativeInfinity,
      ]) {
        final session = AppSession();
        final ok = applyValidatedFxQuote(
          session,
          quote: _quote(from: 'USD', to: 'TZS', rate: rate),
          settlement: 'USD',
          display: 'TZS',
          displayOptions: const ['USD', 'TZS'],
          paymentOptions: const ['USD', 'TZS'],
        );
        expect(ok, isFalse, reason: 'rate=$rate');
        // Session must not have been updated to a fresh cross-currency quote.
        expect(session.fxFresh && session.displayCurrency == 'TZS', isFalse);
      }
    });

    test('currency pair mismatch is rejected', () async {
      final session = AppSession();
      session.preferredDisplayCurrency = 'TZS';
      final api = _client(session, (request) async {
        if (request.url.path.endsWith('/fx/config')) {
          return http.Response(jsonEncode(_config()), 200);
        }
        return http.Response(
          jsonEncode(_quote(from: 'EUR', to: 'GBP', rate: 2)),
          200,
        );
      });

      await api.refreshCurrencyQuote();

      expect(session.fxFresh, isFalse);
      expect(session.fxError, 'fxUnavailable');
      expect(session.displayCurrency, 'USD');
    });

    test('fresh:false quote payload is rejected', () async {
      final session = AppSession();
      session.preferredDisplayCurrency = 'TZS';
      final api = _client(session, (request) async {
        if (request.url.path.endsWith('/fx/config')) {
          return http.Response(jsonEncode(_config()), 200);
        }
        return http.Response(
          jsonEncode(_quote(from: 'USD', to: 'TZS', rate: 2500, fresh: false)),
          200,
        );
      });

      await api.refreshCurrencyQuote();

      expect(session.fxFresh, isFalse);
      expect(session.fxError, 'fxUnavailable');
    });

    test('valid cross-currency quote converts correctly', () async {
      final session = AppSession();
      session.preferredDisplayCurrency = 'TZS';
      final api = _client(session, (request) async {
        if (request.url.path.endsWith('/fx/config')) {
          return http.Response(jsonEncode(_config()), 200);
        }
        expect(request.url.queryParameters['from'], 'USD');
        expect(request.url.queryParameters['to'], 'TZS');
        return http.Response(
          jsonEncode(_quote(from: 'USD', to: 'TZS', rate: 2500)),
          200,
        );
      });

      await api.refreshCurrencyQuote();

      expect(session.fxFresh, isTrue);
      expect(session.fxError, isNull);
      expect(session.displayCurrency, 'TZS');
      expect(session.paymentCurrency, 'TZS');
      expect(session.formatMoney(10), 'TZS 25000.00');
      expect(session.showPaymentEstimate, isFalse);
    });

    test('valid identity conversion still works', () async {
      final session = AppSession();
      session.preferredDisplayCurrency = 'USD';
      var quoteCalls = 0;
      final api = _client(session, (request) async {
        if (request.url.path.endsWith('/fx/config')) {
          return http.Response(jsonEncode(_config()), 200);
        }
        quoteCalls += 1;
        return http.Response('should-not-call', 500);
      });

      await api.refreshCurrencyQuote();

      expect(quoteCalls, 0);
      expect(session.fxFresh, isTrue);
      expect(session.fxError, isNull);
      expect(session.displayCurrency, 'USD');
      expect(session.fxRate, 1);
      expect(session.formatMoney(10), 'USD 10.00');
    });

    test('FX recovers after unavailable without restart', () async {
      final session = AppSession();
      _seedFreshCrossCurrency(session);
      var phase = 0;
      final api = _client(session, (request) async {
        if (phase == 0) {
          return http.Response('down', 500);
        }
        if (request.url.path.endsWith('/fx/config')) {
          return http.Response(jsonEncode(_config()), 200);
        }
        return http.Response(
          jsonEncode(_quote(from: 'USD', to: 'TZS', rate: 2600)),
          200,
        );
      });

      await api.refreshCurrencyQuote();
      expect(session.fxError, 'fxUnavailable');
      expect(session.displayCurrency, 'USD');
      expect(session.preferredDisplayCurrency, 'TZS');

      phase = 1;
      await api.refreshCurrencyQuote();

      expect(session.fxFresh, isTrue);
      expect(session.fxError, isNull);
      expect(session.displayCurrency, 'TZS');
      expect(session.formatMoney(10), 'TZS 26000.00');
    });

    test('unavailable messaging is localised and settlement-labelled', () {
      final session = AppSession();
      markDisplayFxUnavailable(
        session,
        settlement: 'USD',
        displayOptions: const ['USD', 'TZS'],
        paymentOptions: const ['USD', 'TZS'],
      );
      expect(session.formatMoney(12.5), 'USD 12.50');
      expect(
        localisedFxStatusMessage(
          WingerStrings(const Locale('en')),
          session.fxError,
        ),
        contains('Currency rates are unavailable'),
      );
      expect(
        localisedFxStatusMessage(
          WingerStrings(const Locale('es')),
          session.fxError,
        ),
        contains('tasas de cambio'),
      );
      expect(
        localisedFxStatusMessage(
          WingerStrings(const Locale('sw')),
          session.fxError,
        ),
        contains('Viola vya sarafu'),
      );
    });

    test('payment-currency restrictions unchanged for KES display', () async {
      final session = AppSession();
      session.preferredDisplayCurrency = 'KES';
      final api = _client(session, (request) async {
        if (request.url.path.endsWith('/fx/config')) {
          return http.Response(jsonEncode(_config()), 200);
        }
        return http.Response(
          jsonEncode(_quote(from: 'USD', to: 'KES', rate: 129)),
          200,
        );
      });

      await api.refreshCurrencyQuote();

      expect(session.displayCurrency, 'KES');
      expect(session.paymentCurrency, 'USD');
      expect(session.showPaymentEstimate, isTrue);
      expect(session.supportedPaymentCurrencies, ['USD', 'TZS']);
      expect(session.supportedPaymentCurrencies, isNot(contains('KES')));
    });
  });
}
