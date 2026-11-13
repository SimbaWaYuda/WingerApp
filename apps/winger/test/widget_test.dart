import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:winger/core/api/api_client.dart';
import 'package:winger/core/l10n/winger_strings.dart';
import 'package:winger/core/state/app_session.dart';
import 'package:winger/features/auth/continue_purchase_screen.dart';
import 'package:winger/features/auth/login_screen.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('login keeps roles and offers guest shopping', (tester) async {
    SharedPreferences.setMockInitialValues({});
    final session = AppSession();
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider.value(value: session),
          Provider(create: (_) => ApiClient(session)),
        ],
        child: MaterialApp(
          locale: const Locale('en'),
          supportedLocales: WingerStrings.supported,
          localizationsDelegates: const [
            WingerStringsDelegate(),
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          home: const LoginScreen(),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('Shop as a customer'), findsOneWidget);
    expect(find.text('Become a Supplier'), findsOneWidget);
    expect(find.text('Winger administration'), findsOneWidget);
    expect(find.text('Continue shopping as a guest'), findsOneWidget);
    expect(find.text('Remember me on this device'), findsOneWidget);
    expect(find.text('Forgot password?'), findsOneWidget);
    expect(find.text('English'), findsOneWidget);
    await tester.tap(find.text('English'));
    await tester.pumpAndSettle();
    expect(find.text('Español'), findsWidgets);
    expect(find.text('Kiswahili'), findsWidgets);
  });

  testWidgets('checkout prompt puts create account before sign in', (tester) async {
    final session = AppSession()..continueAsGuest();
    await tester.pumpWidget(
      ChangeNotifierProvider.value(
        value: session,
        child: MaterialApp(
          locale: const Locale('en'),
          supportedLocales: WingerStrings.supported,
          localizationsDelegates: const [
            WingerStringsDelegate(),
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          home: const ContinuePurchaseScreen(),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('Continue with your purchase'), findsOneWidget);
    expect(
      find.text(
        'Create an account or sign in to complete your order. Your shopping cart will be saved.',
      ),
      findsOneWidget,
    );
    final create = tester.getTopLeft(find.text('Create an Account →'));
    final signIn = tester.getTopLeft(find.text('Sign In'));
    expect(create.dy, lessThan(signIn.dy));
    expect(find.widgetWithText(FilledButton, 'Create an Account →'), findsOneWidget);
    expect(find.widgetWithText(OutlinedButton, 'Sign In'), findsOneWidget);
  });

  test('guest label is translated', () {
    expect(
      WingerStrings(const Locale('es')).t('continueAsGuest'),
      'Seguir comprando como invitado',
    );
    expect(
      WingerStrings(const Locale('sw')).t('continueAsGuest'),
      'Endelea kununua kama mgeni',
    );
  });
}
