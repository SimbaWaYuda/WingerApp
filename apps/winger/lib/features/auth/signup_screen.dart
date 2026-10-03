import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/l10n/winger_strings.dart';
import '../../core/models/models.dart';
import '../../core/state/app_session.dart';
import '../../core/theme/winger_colors.dart';

class SignupScreen extends StatefulWidget {
  const SignupScreen({super.key});

  @override
  State<SignupScreen> createState() => _SignupScreenState();
}

class _SignupScreenState extends State<SignupScreen> {
  UserRole _role = UserRole.customer;
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _businessName = TextEditingController();
  final _preferredSlug = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    _password.dispose();
    _businessName.dispose();
    _preferredSlug.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final api = context.read<ApiClient>();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await api.register(
        email: _email.text.trim(),
        password: _password.text,
        name: _name.text.trim(),
        role: _role,
        businessName: _role == UserRole.supplier ? _businessName.text.trim() : null,
        preferredSupplierSlug:
            _role == UserRole.supplier && _preferredSlug.text.trim().isNotEmpty
                ? _preferredSlug.text.trim()
                : null,
      );
      if (!mounted) return;
      context.go(switch (_role) {
        UserRole.customer => '/customer',
        UserRole.supplier => '/supplier',
        UserRole.admin => '/admin',
      });
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final session = context.watch<AppSession>();
    final wide = MediaQuery.sizeOf(context).width >= 960;

    final form = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                s.t('signupTitle'),
                style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800),
              ),
            ),
            TextButton(
              onPressed: () => context.go('/login'),
              child: Text(s.t('haveAccount')),
            ),
          ],
        ),
        const SizedBox(height: 8),
        Text(s.t('signupBody'), style: TextStyle(color: WingerColors.muted)),
        const SizedBox(height: 16),
        Wrap(
          spacing: 8,
          children: [
            ChoiceChip(
              label: Text(s.t('shopAsCustomer')),
              selected: _role == UserRole.customer,
              onSelected: (_) => setState(() => _role = UserRole.customer),
            ),
            ChoiceChip(
              label: Text(s.t('manageSupplier')),
              selected: _role == UserRole.supplier,
              onSelected: (_) => setState(() => _role = UserRole.supplier),
            ),
            ChoiceChip(
              label: Text(s.t('wingerAdmin')),
              selected: _role == UserRole.admin,
              onSelected: (_) => setState(() => _role = UserRole.admin),
            ),
          ],
        ),
        const SizedBox(height: 16),
        TextField(
          controller: _name,
          decoration: InputDecoration(labelText: s.t('obName')),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _email,
          keyboardType: TextInputType.emailAddress,
          decoration: InputDecoration(labelText: s.t('email')),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _password,
          obscureText: true,
          decoration: InputDecoration(labelText: s.t('password')),
        ),
        if (_role == UserRole.supplier) ...[
          const SizedBox(height: 12),
          TextField(
            controller: _businessName,
            decoration: InputDecoration(
              labelText: s.t('businessName'),
              helperText: s.t('businessNameHint'),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _preferredSlug,
            decoration: InputDecoration(
              labelText: s.t('preferredSupplierId'),
              helperText: s.t('preferredSupplierIdHint'),
            ),
          ),
        ],
        if (_error != null) ...[
          const SizedBox(height: 12),
          Text(_error!, style: const TextStyle(color: WingerColors.dangerInk, fontSize: 12)),
        ],
        const SizedBox(height: 20),
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: _busy ? null : _submit,
            child: _busy
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                  )
                : Text(s.t('createAccount')),
          ),
        ),
        const SizedBox(height: 12),
        DropdownButton<LocaleCode>(
          value: session.localeCode,
          underline: const SizedBox.shrink(),
          items: const [
            DropdownMenuItem(value: LocaleCode.en, child: Text('English')),
            DropdownMenuItem(value: LocaleCode.es, child: Text('Español')),
            DropdownMenuItem(value: LocaleCode.sw, child: Text('Kiswahili')),
          ],
          onChanged: (value) {
            if (value != null) session.setLocale(value);
          },
        ),
      ],
    );

    if (!wide) {
      return Scaffold(
        body: SafeArea(
          child: ListView(padding: const EdgeInsets.all(20), children: [form]),
        ),
      );
    }

    return Scaffold(
      body: Row(
        children: [
          Expanded(
            child: Container(
              color: WingerColors.brand,
              padding: const EdgeInsets.all(40),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(
                    'Winger',
                    style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                          color: Colors.white,
                          fontWeight: FontWeight.w800,
                        ),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    s.t('signupSide'),
                    style: TextStyle(color: Colors.white.withValues(alpha: 0.9), fontSize: 16, height: 1.4),
                  ),
                ],
              ),
            ),
          ),
          Expanded(
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 480),
                child: SingleChildScrollView(
                  padding: const EdgeInsets.all(32),
                  child: form,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
