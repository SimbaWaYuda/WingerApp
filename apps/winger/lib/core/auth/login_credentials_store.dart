import 'package:shared_preferences/shared_preferences.dart';

import '../models/models.dart';

/// Device-local Remember Me preferences (email + role only).
///
/// Passwords are never persisted. Legacy `winger.login.password` values are
/// scrubbed on every load/save/clear and at app bootstrap.
class SavedLoginPreferences {
  const SavedLoginPreferences({
    required this.email,
    required this.role,
  });

  final String email;
  final UserRole role;
}

class LoginCredentialsStore {
  static const rememberKey = 'winger.login.remember';
  static const emailKey = 'winger.login.email';
  static const roleKey = 'winger.login.role';

  /// Legacy plaintext password key — must never be written again.
  static const legacyPasswordKey = 'winger.login.password';

  /// Any additional legacy auth-secret keys discovered for scrubbing.
  static const List<String> legacySecretKeys = [
    legacyPasswordKey,
  ];

  /// Removes legacy password/secret keys. Safe to call repeatedly.
  /// Does not require a successful login and does not remove unrelated prefs.
  Future<void> scrubLegacySecrets() async {
    final prefs = await SharedPreferences.getInstance();
    for (final key in legacySecretKeys) {
      if (prefs.containsKey(key)) {
        await prefs.remove(key);
      }
    }
  }

  Future<bool> isRememberEnabled() async {
    await scrubLegacySecrets();
    final prefs = await SharedPreferences.getInstance();
    return prefs.getBool(rememberKey) == true;
  }

  Future<SavedLoginPreferences?> load() async {
    await scrubLegacySecrets();
    final prefs = await SharedPreferences.getInstance();
    if (prefs.getBool(rememberKey) != true) return null;
    final email = (prefs.getString(emailKey) ?? '').trim();
    final roleName = prefs.getString(roleKey) ?? '';
    if (email.isEmpty) return null;
    final role = switch (roleName) {
      'supplier' => UserRole.supplier,
      'admin' => UserRole.admin,
      _ => UserRole.customer,
    };
    return SavedLoginPreferences(email: email, role: role);
  }

  /// Persists email + role only when Remember Me is enabled.
  Future<void> save({
    required String email,
    required UserRole role,
  }) async {
    await scrubLegacySecrets();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(rememberKey, true);
    await prefs.setString(emailKey, email.trim());
    await prefs.setString(
      roleKey,
      switch (role) {
        UserRole.customer => 'customer',
        UserRole.supplier => 'supplier',
        UserRole.admin => 'admin',
      },
    );
    // Belt-and-braces: never leave a password key behind after save.
    await scrubLegacySecrets();
  }

  /// Clears Remember Me identity preferences and legacy secrets.
  Future<void> clear() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(rememberKey);
    await prefs.remove(emailKey);
    await prefs.remove(roleKey);
    for (final key in legacySecretKeys) {
      await prefs.remove(key);
    }
  }

  /// Always removes legacy secrets; clears identity only when Remember Me is off.
  Future<void> clearSecretsPreservingRememberedIdentity() async {
    await scrubLegacySecrets();
    final prefs = await SharedPreferences.getInstance();
    if (prefs.getBool(rememberKey) != true) {
      await prefs.remove(emailKey);
      await prefs.remove(roleKey);
      await prefs.remove(rememberKey);
    }
  }
}
