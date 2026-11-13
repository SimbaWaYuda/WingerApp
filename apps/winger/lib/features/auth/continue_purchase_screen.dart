import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../core/l10n/winger_strings.dart';
import '../../core/models/models.dart';
import '../../core/state/app_session.dart';
import '../../core/theme/winger_colors.dart';

class ContinuePurchaseScreen extends StatelessWidget {
  const ContinuePurchaseScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final session = context.watch<AppSession>();
    final s = WingerStrings.of(context);
    final wide = MediaQuery.sizeOf(context).width >= 960;
    final prompt = _PurchasePrompt(
      localeCode: session.localeCode,
      onLocale: session.setLocale,
      onCreateAccount: () => context.go('/signup?from=checkout'),
      onSignIn: () => context.go('/login'),
    );

    if (!wide) {
      return Scaffold(
        body: SafeArea(
          child: ListView(
            padding: const EdgeInsets.all(20),
            children: [
              const _PurchaseBrand(compact: true),
              const SizedBox(height: 24),
              prompt,
            ],
          ),
        ),
      );
    }

    return Scaffold(
      body: Row(
        children: [
          const Expanded(child: ColoredBox(color: WingerColors.brand, child: _PurchaseBrand())),
          Expanded(
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 480),
                child: SingleChildScrollView(
                  padding: const EdgeInsets.all(32),
                  child: prompt,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _PurchaseBrand extends StatelessWidget {
  const _PurchaseBrand({this.compact = false});

  final bool compact;

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final textColor = compact ? WingerColors.dark : Colors.white;
    return Padding(
      padding: EdgeInsets.all(compact ? 0 : 40),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: compact ? MainAxisAlignment.start : MainAxisAlignment.center,
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
        ],
      ),
    );
  }
}

class _PurchasePrompt extends StatelessWidget {
  const _PurchasePrompt({
    required this.localeCode,
    required this.onLocale,
    required this.onCreateAccount,
    required this.onSignIn,
  });

  final LocaleCode localeCode;
  final ValueChanged<LocaleCode> onLocale;
  final VoidCallback onCreateAccount;
  final VoidCallback onSignIn;

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
                s.t('continuePurchaseTitle'),
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
        const SizedBox(height: 12),
        Text(
          s.t('continuePurchaseBody'),
          style: const TextStyle(color: WingerColors.ink, height: 1.45),
        ),
        const SizedBox(height: 24),
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: onCreateAccount,
            child: Text(s.t('continuePurchaseCreate')),
          ),
        ),
        const SizedBox(height: 12),
        SizedBox(
          width: double.infinity,
          child: OutlinedButton(
            onPressed: onSignIn,
            child: Text(s.t('continuePurchaseSignIn')),
          ),
        ),
      ],
    );
  }
}
