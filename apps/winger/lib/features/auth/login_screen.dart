import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/l10n/winger_strings.dart';
import '../../core/models/models.dart';
import '../../core/state/app_session.dart';
import '../../core/theme/winger_colors.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  UserRole _role = UserRole.customer;
  final _email = TextEditingController(text: 'amina.mwangi@example.com');
  final _password = TextEditingController(text: 'demo1234');
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  void _onRole(UserRole role) {
    setState(() {
      _role = role;
      _error = null;
      _email.text = switch (role) {
        UserRole.customer => 'amina.mwangi@example.com',
        UserRole.supplier => 'supplier@kijani.example',
        UserRole.admin => 'admin@winger.example',
      };
    });
  }

  Future<void> _continue() async {
    final api = context.read<ApiClient>();
    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      await api.login(
        email: _email.text.trim(),
        password: _password.text,
        role: _role,
      );
      if (!mounted) return;
      context.go(switch (_role) {
        UserRole.customer => '/customer',
        UserRole.supplier => '/supplier',
        UserRole.admin => '/admin',
      });
    } catch (error) {
      final apiReachable = await api.healthCheck();
      if (!mounted) return;
      final s = WingerStrings.of(context);
      setState(() {
        _error = apiReachable
            ? error.toString().replaceFirst('Exception: ', '')
            : s.t('apiOffline');
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = context.watch<AppSession>();
    final wide = MediaQuery.sizeOf(context).width >= 960;

    final form = _LoginForm(
      role: _role,
      email: _email,
      password: _password,
      busy: _busy,
      error: _error,
      onRole: _onRole,
      onLocale: (code) => session.setLocale(code),
      localeCode: session.localeCode,
      onContinue: _busy ? null : _continue,
    );

    if (!wide) {
      return Scaffold(
        body: SafeArea(
          child: ListView(
            padding: const EdgeInsets.all(20),
            children: [
              const _BrandBlock(compact: true),
              const SizedBox(height: 24),
              form,
            ],
          ),
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
              child: const _BrandBlock(),
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

class _BrandBlock extends StatelessWidget {
  const _BrandBlock({this.compact = false});

  final bool compact;

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final textColor = compact ? WingerColors.dark : Colors.white;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        Row(
          children: [
            Container(
              width: 42,
              height: 42,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: compact ? WingerColors.brand : Colors.white.withValues(alpha: 0.15),
                borderRadius: BorderRadius.circular(12),
              ),
              child: const Text(
                'W',
                style: TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 20),
              ),
            ),
            const SizedBox(width: 12),
            Text(
              'Winger\n${s.t('tagline').toUpperCase()}',
              style: TextStyle(color: textColor, fontWeight: FontWeight.w700, height: 1.15),
            ),
          ],
        ),
        SizedBox(height: compact ? 20 : 40),
        Text(
          s.t('oneLogin'),
          style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                color: textColor,
                fontWeight: FontWeight.w800,
              ),
        ),
        const SizedBox(height: 12),
        Text(
          s.t('oneLoginBody'),
          style: TextStyle(color: textColor.withValues(alpha: 0.85), height: 1.45, fontSize: 16),
        ),
      ],
    );
  }
}

class _LoginForm extends StatelessWidget {
  const _LoginForm({
    required this.role,
    required this.email,
    required this.password,
    required this.busy,
    required this.error,
    required this.onRole,
    required this.onLocale,
    required this.localeCode,
    required this.onContinue,
  });

  final UserRole role;
  final TextEditingController email;
  final TextEditingController password;
  final bool busy;
  final String? error;
  final ValueChanged<UserRole> onRole;
  final ValueChanged<LocaleCode> onLocale;
  final LocaleCode localeCode;
  final VoidCallback? onContinue;

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                s.t('welcome'),
                style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800),
              ),
            ),
            DropdownButton<LocaleCode>(
              value: localeCode,
              underline: const SizedBox.shrink(),
              items: const [
                DropdownMenuItem(value: LocaleCode.en, child: Text('English')),
                DropdownMenuItem(value: LocaleCode.es, child: Text('Español')),
                DropdownMenuItem(value: LocaleCode.sw, child: Text('Kiswahili')),
              ],
              onChanged: (value) {
                if (value != null) onLocale(value);
              },
            ),
          ],
        ),
        const SizedBox(height: 20),
        _RoleCard(
          selected: role == UserRole.customer,
          title: s.t('shopAsCustomer'),
          body: s.t('shopAsCustomerBody'),
          icon: Icons.shopping_bag_outlined,
          onTap: () => onRole(UserRole.customer),
        ),
        _RoleCard(
          selected: role == UserRole.supplier,
          title: s.t('manageSupplier'),
          body: s.t('manageSupplierBody'),
          icon: Icons.storefront_outlined,
          onTap: () => onRole(UserRole.supplier),
        ),
        _RoleCard(
          selected: role == UserRole.admin,
          title: s.t('wingerAdmin'),
          body: s.t('wingerAdminBody'),
          icon: Icons.verified_user_outlined,
          onTap: () => onRole(UserRole.admin),
        ),
        const SizedBox(height: 16),
        TextField(
          controller: email,
          decoration: InputDecoration(labelText: s.t('email')),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: password,
          obscureText: true,
          decoration: InputDecoration(labelText: s.t('password')),
        ),
        if (error != null) ...[
          const SizedBox(height: 12),
          Text(error!, style: const TextStyle(color: WingerColors.dangerInk, fontSize: 12)),
        ],
        const SizedBox(height: 20),
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: onContinue,
            child: busy
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                  )
                : Text('${s.t('continueRole')} →'),
          ),
        ),
        const SizedBox(height: 12),
        Center(
          child: TextButton(
            onPressed: () => context.go('/signup'),
            child: Text(s.t('createAccountLink')),
          ),
        ),
        const SizedBox(height: 16),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: WingerColors.brandMuted,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Text(
            '${s.t('languageHint')}\n\nDemo password: demo1234\n'
            'Customer: amina.mwangi@example.com\n'
            'Supplier: supplier@kijani.example\n'
            'Supplier (Savanna): supplier@savanna.example\n'
            'Admin: admin@winger.example',
          ),
        ),
      ],
    );
  }
}

class _RoleCard extends StatelessWidget {
  const _RoleCard({
    required this.selected,
    required this.title,
    required this.body,
    required this.icon,
    required this.onTap,
  });

  final bool selected;
  final String title;
  final String body;
  final IconData icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: Ink(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: selected ? WingerColors.brandMuted : WingerColors.white,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(
              color: selected ? WingerColors.brand : WingerColors.border,
              width: selected ? 1.5 : 1,
            ),
          ),
          child: Row(
            children: [
              Icon(icon, color: WingerColors.brand),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: const TextStyle(fontWeight: FontWeight.w800)),
                    const SizedBox(height: 2),
                    Text(body, style: const TextStyle(color: WingerColors.muted)),
                  ],
                ),
              ),
              if (selected) const Icon(Icons.check_circle, color: WingerColors.brand),
            ],
          ),
        ),
      ),
    );
  }
}
