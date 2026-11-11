import 'package:shared_preferences/shared_preferences.dart';

import '../models/models.dart';

/// Device-local saved sign-in fields when the user opts into Remember me.
class SavedLoginCredentials {
  const SavedLoginCredentials({
    required this.email,
    required this.password,
    required this.role,
  });

  final String email;
  final String password;
  final UserRole role;
}

class LoginCredentialsStore {
  static const _rememberKey = 'winger.login.remember';
  static const _emailKey = 'winger.login.email';
  static const _passwordKey = 'winger.login.password';
  static const _roleKey = 'winger.login.role';

  Future<SavedLoginCredentials?> load() async {
    final prefs = await SharedPreferences.getInstance();
    if (prefs.getBool(_rememberKey) != true) return null;
    final email = (prefs.getString(_emailKey) ?? '').trim();
    final password = prefs.getString(_passwordKey) ?? '';
    final roleName = prefs.getString(_roleKey) ?? '';
    if (email.isEmpty || password.isEmpty) return null;
    final role = switch (roleName) {
      'supplier' => UserRole.supplier,
      'admin' => UserRole.admin,
      _ => UserRole.customer,
    };
    return SavedLoginCredentials(email: email, password: password, role: role);
  }

  Future<void> save({
    required String email,
    required String password,
    required UserRole role,
  }) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_rememberKey, true);
    await prefs.setString(_emailKey, email.trim());
    await prefs.setString(_passwordKey, password);
    await prefs.setString(
      _roleKey,
      switch (role) {
        UserRole.customer => 'customer',
        UserRole.supplier => 'supplier',
        UserRole.admin => 'admin',
      },
    );
  }

  Future<void> clear() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_rememberKey);
    await prefs.remove(_emailKey);
    await prefs.remove(_passwordKey);
    await prefs.remove(_roleKey);
  }
}
