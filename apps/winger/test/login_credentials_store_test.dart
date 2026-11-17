import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:winger/core/auth/login_credentials_store.dart';
import 'package:winger/core/api/api_client.dart';
import 'package:winger/core/models/models.dart';
import 'package:winger/core/state/app_session.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  group('LoginCredentialsStore password persistence', () {
    test('T1 Remember Me save never persists a password key', () async {
      final store = LoginCredentialsStore();
      await store.save(email: 'amina@example.com', role: UserRole.customer);

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getBool(LoginCredentialsStore.rememberKey), isTrue);
      expect(prefs.getString(LoginCredentialsStore.emailKey), 'amina@example.com');
      expect(prefs.getString(LoginCredentialsStore.roleKey), 'customer');
      expect(prefs.containsKey(LoginCredentialsStore.legacyPasswordKey), isFalse);
      expect(prefs.getString(LoginCredentialsStore.legacyPasswordKey), isNull);

      final loaded = await store.load();
      expect(loaded?.email, 'amina@example.com');
      expect(loaded?.role, UserRole.customer);
    });

    test('T2 legacy password keys are removed on scrub', () async {
      SharedPreferences.setMockInitialValues({
        LoginCredentialsStore.rememberKey: true,
        LoginCredentialsStore.emailKey: 'old@example.com',
        LoginCredentialsStore.roleKey: 'supplier',
        LoginCredentialsStore.legacyPasswordKey: 'should-not-survive',
      });

      final store = LoginCredentialsStore();
      await store.scrubLegacySecrets();

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.containsKey(LoginCredentialsStore.legacyPasswordKey), isFalse);
      expect(prefs.getString(LoginCredentialsStore.emailKey), 'old@example.com');
    });

    test('T3 migration scrub is safe when executed repeatedly', () async {
      SharedPreferences.setMockInitialValues({
        LoginCredentialsStore.legacyPasswordKey: 'once',
        'unrelated.app.flag': true,
      });
      final store = LoginCredentialsStore();
      await store.scrubLegacySecrets();
      await store.scrubLegacySecrets();
      await store.load();
      await store.scrubLegacySecrets();

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.containsKey(LoginCredentialsStore.legacyPasswordKey), isFalse);
      expect(prefs.getBool('unrelated.app.flag'), isTrue);
    });

    test('T4 logout clears session and legacy authentication secrets', () async {
      SharedPreferences.setMockInitialValues({
        LoginCredentialsStore.rememberKey: false,
        LoginCredentialsStore.emailKey: 'x@example.com',
        LoginCredentialsStore.roleKey: 'admin',
        LoginCredentialsStore.legacyPasswordKey: 'secret',
      });

      final session = AppSession();
      session.applyAuth(
        token: 'test-token',
        id: 'u1',
        name: 'Test',
        mail: 'x@example.com',
        selectedRole: UserRole.admin,
      );
      expect(session.isSignedIn, isTrue);
      expect(session.accessToken, 'test-token');

      await session.signOut();

      expect(session.isSignedIn, isFalse);
      expect(session.accessToken, isNull);
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.containsKey(LoginCredentialsStore.legacyPasswordKey), isFalse);
      expect(prefs.getString(LoginCredentialsStore.emailKey), isNull);
      expect(prefs.getBool(LoginCredentialsStore.rememberKey), isNull);
    });

    test('T4b logout preserves remembered email/role when Remember Me is on', () async {
      SharedPreferences.setMockInitialValues({
        LoginCredentialsStore.rememberKey: true,
        LoginCredentialsStore.emailKey: 'keep@example.com',
        LoginCredentialsStore.roleKey: 'customer',
        LoginCredentialsStore.legacyPasswordKey: 'wipe-me',
      });

      final session = AppSession();
      session.applyAuth(
        token: 'tok',
        id: 'u2',
        name: 'Keep',
        mail: 'keep@example.com',
        selectedRole: UserRole.customer,
      );
      await session.signOut();

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.containsKey(LoginCredentialsStore.legacyPasswordKey), isFalse);
      expect(prefs.getBool(LoginCredentialsStore.rememberKey), isTrue);
      expect(prefs.getString(LoginCredentialsStore.emailKey), 'keep@example.com');
      expect(prefs.getString(LoginCredentialsStore.roleKey), 'customer');
    });

    test('T5 web-style prefs mock never retains a password after save/load', () async {
      // SharedPreferences mock covers the same API used on Web.
      final store = LoginCredentialsStore();
      SharedPreferences.setMockInitialValues({
        LoginCredentialsStore.legacyPasswordKey: 'from-web-local',
      });
      await store.save(email: 'web@example.com', role: UserRole.customer);
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.containsKey(LoginCredentialsStore.legacyPasswordKey), isFalse);
      expect(prefs.getString(LoginCredentialsStore.legacyPasswordKey), isNull);
    });

    test('T6 customer, supplier and admin remember roles remain compatible', () async {
      final store = LoginCredentialsStore();
      for (final role in UserRole.values) {
        await store.save(email: '${role.name}@example.com', role: role);
        final loaded = await store.load();
        expect(loaded?.role, role);
        expect(loaded?.email, '${role.name}@example.com');
        final prefs = await SharedPreferences.getInstance();
        expect(prefs.containsKey(LoginCredentialsStore.legacyPasswordKey), isFalse);
      }
    });

    test('T7 guest browsing remains unaffected by credential scrub', () async {
      final session = AppSession();
      await LoginCredentialsStore().scrubLegacySecrets();
      session.continueAsGuest();
      expect(session.browsingAsGuest, isTrue);
      expect(session.isSignedIn, isFalse);
      expect(session.accessToken, isNull);
    });

    test('T8 unchecking Remember Me clears identity and secrets', () async {
      SharedPreferences.setMockInitialValues({
        LoginCredentialsStore.rememberKey: true,
        LoginCredentialsStore.emailKey: 'r@example.com',
        LoginCredentialsStore.roleKey: 'supplier',
        LoginCredentialsStore.legacyPasswordKey: 'nope',
      });
      final store = LoginCredentialsStore();
      await store.clear();
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getBool(LoginCredentialsStore.rememberKey), isNull);
      expect(prefs.getString(LoginCredentialsStore.emailKey), isNull);
      expect(prefs.getString(LoginCredentialsStore.roleKey), isNull);
      expect(prefs.containsKey(LoginCredentialsStore.legacyPasswordKey), isFalse);
    });

    test('T9 expired auth clears authenticated session state', () async {
      final session = AppSession();
      final api = ApiClient(session);
      session.applyAuth(
        token: 'expired-token',
        id: 'u3',
        name: 'Gone',
        mail: 'gone@example.com',
        selectedRole: UserRole.customer,
      );
      expect(session.isSignedIn, isTrue);

      api.applyUnauthorizedForTest();
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(const Duration(milliseconds: 10));

      expect(session.isSignedIn, isFalse);
      expect(session.accessToken, isNull);
    });

    test('T10 saved preferences model has no password field', () async {
      final store = LoginCredentialsStore();
      await store.save(email: 'safe@example.com', role: UserRole.customer);
      final loaded = await store.load();
      expect(loaded, isNotNull);
      // Compile-time/API surface: SavedLoginPreferences only exposes email + role.
      expect(loaded!.email, 'safe@example.com');
      expect(loaded.role, UserRole.customer);
      final prefs = await SharedPreferences.getInstance();
      for (final key in prefs.getKeys()) {
        if (key.toLowerCase().contains('password')) {
          fail('Password-related preference key still present: $key');
        }
      }
    });
  });
}
