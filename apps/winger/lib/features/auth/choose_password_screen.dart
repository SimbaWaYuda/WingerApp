import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/l10n/winger_strings.dart';
import '../../core/models/models.dart';
import '../../core/state/app_session.dart';
import '../../core/theme/winger_colors.dart';

class ChoosePasswordScreen extends StatefulWidget {
  const ChoosePasswordScreen({super.key});

  @override
  State<ChoosePasswordScreen> createState() => _ChoosePasswordScreenState();
}

class _ChoosePasswordScreenState extends State<ChoosePasswordScreen> {
  final _current = TextEditingController();
  final _next = TextEditingController();
  final _confirm = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _current.dispose();
    _next.dispose();
    _confirm.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final s = WingerStrings.of(context);
    if (_next.text != _confirm.text) {
      setState(() => _error = s.t('passwordMismatch'));
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await context.read<ApiClient>().changePassword(
        currentPassword: _current.text,
        newPassword: _next.text,
      );
      if (!mounted) return;
      final role = context.read<AppSession>().role;
      context.go(switch (role) {
        UserRole.supplier => '/supplier',
        UserRole.admin => '/admin',
        _ => '/customer',
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error.toString().replaceFirst('Exception: ', '');
        _busy = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final session = context.watch<AppSession>();
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 440),
            child: ListView(
              padding: const EdgeInsets.all(24),
              shrinkWrap: true,
              children: [
                Text(
                  s.t('choosePassword'),
                  style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  s.t('choosePasswordHint'),
                  style: TextStyle(color: WingerColors.muted),
                ),
                const SizedBox(height: 8),
                Text(session.email),
                const SizedBox(height: 16),
                TextField(
                  controller: _current,
                  obscureText: true,
                  decoration: InputDecoration(
                    labelText: s.t('temporaryPassword'),
                  ),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: _next,
                  obscureText: true,
                  decoration: InputDecoration(labelText: s.t('newPassword')),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: _confirm,
                  obscureText: true,
                  decoration: InputDecoration(labelText: s.t('confirmPassword')),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 8),
                  Text(
                    _error!,
                    style: const TextStyle(color: WingerColors.dangerInk),
                  ),
                ],
                const SizedBox(height: 16),
                FilledButton(
                  onPressed: _busy ? null : _save,
                  child: Text(s.t('choosePassword')),
                ),
                const SizedBox(height: 8),
                TextButton(
                  onPressed: _busy
                      ? null
                      : () {
                          session.signOut();
                          context.go('/login');
                        },
                  child: Text(s.t('signOut')),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
