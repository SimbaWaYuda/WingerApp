import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/l10n/winger_strings.dart';
import '../../core/theme/winger_colors.dart';

class ChangePasswordCard extends StatefulWidget {
  const ChangePasswordCard({super.key});

  @override
  State<ChangePasswordCard> createState() => _ChangePasswordCardState();
}

class _ChangePasswordCardState extends State<ChangePasswordCard> {
  final _current = TextEditingController();
  final _next = TextEditingController();
  final _confirm = TextEditingController();
  bool _busy = false;
  String? _notice;
  bool _ok = false;

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
      setState(() {
        _ok = false;
        _notice = s.t('passwordMismatch');
      });
      return;
    }
    setState(() {
      _busy = true;
      _notice = null;
    });
    try {
      await context.read<ApiClient>().changePassword(
        currentPassword: _current.text,
        newPassword: _next.text,
      );
      if (!mounted) return;
      _current.clear();
      _next.clear();
      _confirm.clear();
      setState(() {
        _ok = true;
        _notice = s.t('passwordChanged');
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _ok = false;
        _notice = error.toString().replaceFirst('Exception: ', '');
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              s.t('changePassword'),
              style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _current,
              obscureText: true,
              decoration: InputDecoration(labelText: s.t('currentPassword')),
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
            if (_notice != null) ...[
              const SizedBox(height: 8),
              Text(
                _notice!,
                style: TextStyle(
                  color: _ok ? WingerColors.successInk : WingerColors.dangerInk,
                ),
              ),
            ],
            const SizedBox(height: 12),
            FilledButton(
              onPressed: _busy ? null : _save,
              child: Text(s.t('changePassword')),
            ),
          ],
        ),
      ),
    );
  }
}

class AdminPasswordResetCard extends StatefulWidget {
  const AdminPasswordResetCard({super.key});

  @override
  State<AdminPasswordResetCard> createState() => _AdminPasswordResetCardState();
}

class _AdminPasswordResetCardState extends State<AdminPasswordResetCard> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _confirm = TextEditingController();
  bool _busy = false;
  String? _notice;
  bool _ok = false;
  List<Map<String, dynamic>> _requests = const [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    _confirm.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final rows = await context.read<ApiClient>().fetchPasswordResetRequests();
      if (!mounted) return;
      setState(() => _requests = rows);
    } catch (_) {
      if (!mounted) return;
      setState(() => _requests = const []);
    }
  }

  Future<void> _reset() async {
    final s = WingerStrings.of(context);
    if (_password.text != _confirm.text) {
      setState(() {
        _ok = false;
        _notice = s.t('passwordMismatch');
      });
      return;
    }
    setState(() {
      _busy = true;
      _notice = null;
    });
    try {
      final email = await context.read<ApiClient>().resetAccountPassword(
        email: _email.text.trim(),
        password: _password.text,
      );
      if (!mounted) return;
      _password.clear();
      _confirm.clear();
      setState(() {
        _ok = true;
        _notice = '${s.t('temporaryPasswordSaved')} $email';
      });
      await _load();
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _ok = false;
        _notice = error.toString().replaceFirst('Exception: ', '');
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              s.t('resetPassword'),
              style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18),
            ),
            const SizedBox(height: 4),
            Text(
              s.t('resetPasswordHint'),
              style: TextStyle(color: WingerColors.muted),
            ),
            const SizedBox(height: 12),
            Text(
              s.t('resetRequests'),
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 4),
            if (_requests.isEmpty)
              Text(
                s.t('noResetRequests'),
                style: TextStyle(color: WingerColors.muted),
              )
            else
              for (final row in _requests)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text(row['email']?.toString() ?? ''),
                  subtitle: Text(
                    '${row['name'] ?? ''} · ${row['role'] ?? ''}',
                  ),
                  trailing: TextButton(
                    onPressed: () {
                      _email.text = row['email']?.toString() ?? '';
                    },
                    child: Text(s.t('useThisEmail')),
                  ),
                ),
            const SizedBox(height: 8),
            TextField(
              controller: _email,
              keyboardType: TextInputType.emailAddress,
              decoration: InputDecoration(labelText: s.t('email')),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _password,
              obscureText: true,
              decoration: InputDecoration(labelText: s.t('newPassword')),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _confirm,
              obscureText: true,
              decoration: InputDecoration(labelText: s.t('confirmPassword')),
            ),
            if (_notice != null) ...[
              const SizedBox(height: 8),
              Text(
                _notice!,
                style: TextStyle(
                  color: _ok ? WingerColors.successInk : WingerColors.dangerInk,
                ),
              ),
            ],
            const SizedBox(height: 12),
            FilledButton(
              onPressed: _busy ? null : _reset,
              child: Text(s.t('resetPassword')),
            ),
          ],
        ),
      ),
    );
  }
}
