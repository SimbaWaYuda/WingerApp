import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../core/analytics/analytics.dart';
import '../../core/api/api_client.dart';
import '../../core/l10n/winger_strings.dart';
import '../../core/state/app_session.dart';
import '../../core/theme/winger_colors.dart';
import 'onboarding_models.dart';

class CustomerOnboardingScreen extends StatefulWidget {
  const CustomerOnboardingScreen({super.key});

  @override
  State<CustomerOnboardingScreen> createState() => _CustomerOnboardingScreenState();
}

class _CustomerOnboardingScreenState extends State<CustomerOnboardingScreen> {
  final _name = TextEditingController();
  final _phone = TextEditingController();
  final _city = TextEditingController(text: 'Nairobi');
  final _address = TextEditingController(text: 'Westlands');
  OnboardingProgress? _progress;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    final session = context.read<AppSession>();
    _name.text = session.displayName;
    _phone.text = session.phone;
    _city.text = session.city;
    _address.text = session.addressLine;
    _load();
  }

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    _city.dispose();
    _address.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final progress = await context.read<ApiClient>().startOnboarding();
      if (!mounted) return;
      setState(() => _progress = progress);
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error.toString());
    }
  }

  Future<void> _saveProfile() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final progress = await context.read<ApiClient>().saveOnboardingProfile(
            name: _name.text.trim(),
            phone: _phone.text.trim(),
            city: _city.text.trim(),
            addressLine: _address.text.trim(),
          );
      await context.read<Analytics>().firstMeaningfulAction(
            role: 'CUSTOMER',
            action: 'profile_saved',
          );
      if (!mounted) return;
      setState(() => _progress = progress);
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _savePrefs(LocaleCode code) async {
    setState(() => _busy = true);
    try {
      await context.read<AppSession>().setLocale(code);
      final progress =
          await context.read<ApiClient>().saveOnboardingPreferences(code.code);
      if (!mounted) return;
      setState(() => _progress = progress);
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final session = context.watch<AppSession>();
    final progress = _progress;

    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Text(s.t('obCustomerJourney'), style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
        const SizedBox(height: 8),
        Text(s.t('obCustomerJourneyBody'), style: TextStyle(color: WingerColors.muted)),
        if (_error != null) ...[
          const SizedBox(height: 12),
          Text(_error!, style: const TextStyle(color: WingerColors.dangerInk)),
        ],
        const SizedBox(height: 20),
        Text(s.t('obCustomerProfile'), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
        const SizedBox(height: 8),
        TextField(controller: _name, decoration: InputDecoration(labelText: s.t('obName'))),
        const SizedBox(height: 8),
        TextField(controller: _phone, decoration: InputDecoration(labelText: s.t('obPhone'))),
        const SizedBox(height: 8),
        TextField(
          controller: _address,
          decoration: InputDecoration(labelText: s.t('addressLine'), hintText: 'Westlands'),
        ),
        const SizedBox(height: 8),
        TextField(controller: _city, decoration: InputDecoration(labelText: s.t('obCity'))),
        const SizedBox(height: 12),
        FilledButton(
          onPressed: _busy ? null : _saveProfile,
          child: Text(s.t('obSaveProfile')),
        ),
        const SizedBox(height: 24),
        Text(s.t('obCustomerPrefs'), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          children: [
            for (final code in LocaleCode.values)
              ChoiceChip(
                label: Text(switch (code) {
                  LocaleCode.en => 'English',
                  LocaleCode.es => 'Español',
                  LocaleCode.sw => 'Kiswahili',
                }),
                selected: session.localeCode == code,
                onSelected: _busy ? null : (_) => _savePrefs(code),
              ),
          ],
        ),
        const SizedBox(height: 24),
        Text(s.t('obNextSteps'), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
        const SizedBox(height: 8),
        _LinkCard(
          title: s.t('obCustomerDiscovery'),
          body: s.t('obCustomerDiscoveryBody'),
          onTap: () async {
            await context.read<ApiClient>().stampOnboardingActivity('browsed_catalog');
            if (context.mounted) context.go('/customer/search');
          },
        ),
        _LinkCard(
          title: s.t('obCustomerCompare'),
          body: s.t('obCustomerCompareBody'),
          onTap: () async {
            await context.read<ApiClient>().stampOnboardingActivity('compared_products');
            if (context.mounted) context.go('/customer/compare');
          },
        ),
        _LinkCard(
          title: s.t('obCustomerCart'),
          body: s.t('obCustomerCartBody'),
          onTap: () => context.go('/customer/cart'),
        ),
        _LinkCard(
          title: s.t('obCustomerCheckout'),
          body: s.t('obCustomerCheckoutBody'),
          onTap: () => context.go('/customer/checkout'),
        ),
        _LinkCard(
          title: s.t('obCustomerTracking'),
          body: s.t('obCustomerTrackingBody'),
          onTap: () async {
            await context.read<ApiClient>().stampOnboardingActivity('viewed_orders');
            if (context.mounted) context.go('/customer/orders');
          },
        ),
        if (progress != null) ...[
          const SizedBox(height: 16),
          Text('${s.t('obProgress')}: ${progress.percent}%'),
        ],
      ],
    );
  }
}

class SupplierOnboardingScreen extends StatefulWidget {
  const SupplierOnboardingScreen({super.key});

  @override
  State<SupplierOnboardingScreen> createState() => _SupplierOnboardingScreenState();
}

class _SupplierOnboardingScreenState extends State<SupplierOnboardingScreen> {
  final _bio = TextEditingController();
  final _delivery = TextEditingController(text: 'Express, Standard, Pickup');
  String? _error;
  bool _busy = false;
  OnboardingProgress? _progress;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _bio.dispose();
    _delivery.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final progress = await context.read<ApiClient>().startOnboarding();
      if (!mounted) return;
      setState(() => _progress = progress);
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error.toString());
    }
  }

  Future<void> _run(Future<OnboardingProgress> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final progress = await action();
      if (!mounted) return;
      setState(() => _progress = progress);
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final api = context.read<ApiClient>();

    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Text(s.t('obSupplierJourney'), style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
        const SizedBox(height: 8),
        Text(s.t('obSupplierJourneyBody'), style: TextStyle(color: WingerColors.muted)),
        if (_error != null) ...[
          const SizedBox(height: 12),
          Text(_error!, style: const TextStyle(color: WingerColors.dangerInk)),
        ],
        const SizedBox(height: 16),
        TextField(
          controller: _bio,
          maxLines: 3,
          decoration: InputDecoration(labelText: s.t('obSupplierBusiness'), hintText: s.t('obSupplierBusinessBody')),
        ),
        const SizedBox(height: 8),
        FilledButton(
          onPressed: _busy
              ? null
              : () => _run(() => api.postOnboarding('/supplier/business', {
                    'businessBio': _bio.text.trim(),
                  })),
          child: Text(s.t('obSaveBusiness')),
        ),
        const SizedBox(height: 12),
        OutlinedButton(
          onPressed: _busy ? null : () => _run(() => api.postOnboarding('/supplier/verification')),
          child: Text(s.t('obSubmitVerification')),
        ),
        const SizedBox(height: 8),
        OutlinedButton(
          onPressed: _busy ? null : () => _run(() => api.postOnboarding('/supplier/payout')),
          child: Text(s.t('obSetupPayout')),
        ),
        const SizedBox(height: 12),
        TextField(controller: _delivery, decoration: InputDecoration(labelText: s.t('obSupplierDelivery'))),
        const SizedBox(height: 8),
        OutlinedButton(
          onPressed: _busy
              ? null
              : () => _run(() => api.postOnboarding('/supplier/delivery', {
                    'notes': _delivery.text.trim(),
                  })),
          child: Text(s.t('obSaveDelivery')),
        ),
        const SizedBox(height: 20),
        _LinkCard(
          title: s.t('obSupplierListing'),
          body: s.t('obSupplierListingBody'),
          onTap: () async {
            try {
              await api.completeOnboardingTask('supplier.listing');
            } catch (_) {}
            if (context.mounted) context.go('/supplier/products');
          },
        ),
        _LinkCard(
          title: s.t('obSupplierInventory'),
          body: s.t('obSupplierInventoryBody'),
          onTap: () async {
            await api.stampOnboardingActivity('received_inventory');
            if (context.mounted) context.go('/supplier/products');
          },
        ),
        _LinkCard(
          title: s.t('obSupplierFulfillment'),
          body: s.t('obSupplierFulfillmentBody'),
          onTap: () => context.go('/supplier/orders'),
        ),
        if (_progress != null) ...[
          const SizedBox(height: 12),
          Text('${s.t('obProgress')}: ${_progress!.percent}%'),
        ],
      ],
    );
  }
}

class AdminOnboardingScreen extends StatefulWidget {
  const AdminOnboardingScreen({super.key});

  @override
  State<AdminOnboardingScreen> createState() => _AdminOnboardingScreenState();
}

class _AdminOnboardingScreenState extends State<AdminOnboardingScreen> {
  OnboardingProgress? _progress;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final progress = await context.read<ApiClient>().startOnboarding();
      if (!mounted) return;
      setState(() => _progress = progress);
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error.toString());
    }
  }

  Future<void> _flag(Map<String, dynamic> body) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final progress =
          await context.read<ApiClient>().postOnboarding('/admin/platform', body);
      if (!mounted) return;
      setState(() => _progress = progress);
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final api = context.read<ApiClient>();

    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Text(s.t('obAdminJourney'), style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
        const SizedBox(height: 8),
        Text(s.t('obAdminJourneyBody'), style: TextStyle(color: WingerColors.muted)),
        if (_error != null) ...[
          const SizedBox(height: 12),
          Text(_error!, style: const TextStyle(color: WingerColors.dangerInk)),
        ],
        const SizedBox(height: 16),
        FilledButton(
          onPressed: _busy ? null : () => _flag({'setupComplete': true, 'currency': 'USD', 'timezone': 'Africa/Nairobi'}),
          child: Text(s.t('obAdminPlatform')),
        ),
        const SizedBox(height: 8),
        OutlinedButton(
          onPressed: _busy ? null : () => _flag({'permissionsSeeded': true}),
          child: Text(s.t('obAdminPermissions')),
        ),
        const SizedBox(height: 8),
        OutlinedButton(
          onPressed: _busy
              ? null
              : () async {
                  setState(() => _busy = true);
                  try {
                    final progress = await api.postOnboarding('/admin/approve-supplier/s-kijani');
                    if (!mounted) return;
                    setState(() => _progress = progress);
                  } catch (error) {
                    if (!mounted) return;
                    setState(() => _error = error.toString());
                  } finally {
                    if (mounted) setState(() => _busy = false);
                  }
                },
          child: Text(s.t('obAdminApprovals')),
        ),
        const SizedBox(height: 8),
        OutlinedButton(
          onPressed: _busy ? null : () => _flag({'deliveryConfigured': true}),
          child: Text(s.t('obAdminDelivery')),
        ),
        const SizedBox(height: 8),
        OutlinedButton(
          onPressed: _busy ? null : () => _flag({'paymentsConfigured': true}),
          child: Text(s.t('obAdminPayments')),
        ),
        const SizedBox(height: 8),
        OutlinedButton(
          onPressed: _busy ? null : () => _flag({'commissionsConfigured': true}),
          child: Text(s.t('obAdminCommissions')),
        ),
        const SizedBox(height: 16),
        _LinkCard(
          title: s.t('obAdminCatalogue'),
          body: s.t('obAdminCatalogueBody'),
          onTap: () async {
            await api.stampOnboardingActivity('viewed_catalogue_admin');
            try {
              await api.completeOnboardingTask('admin.catalogue');
            } catch (_) {}
            if (context.mounted) context.go('/admin');
          },
        ),
        _LinkCard(
          title: s.t('obAdminOrderOps'),
          body: s.t('obAdminOrderOpsBody'),
          onTap: () async {
            try {
              await api.completeOnboardingTask('admin.orderOps');
            } catch (_) {}
            if (context.mounted) context.go('/admin/orders');
          },
        ),
        if (_progress != null) ...[
          const SizedBox(height: 12),
          Text('${s.t('obProgress')}: ${_progress!.percent}%'),
        ],
      ],
    );
  }
}

class _LinkCard extends StatelessWidget {
  const _LinkCard({
    required this.title,
    required this.body,
    required this.onTap,
  });

  final String title;
  final String body;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: ListTile(
        title: Text(title, style: const TextStyle(fontWeight: FontWeight.w700)),
        subtitle: Text(body),
        trailing: const Icon(Icons.arrow_forward),
        onTap: onTap,
      ),
    );
  }
}
