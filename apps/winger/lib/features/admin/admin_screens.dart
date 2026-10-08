import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/data/mock_catalog.dart';
import '../../core/l10n/winger_strings.dart';
import '../../core/models/models.dart';
import '../../core/repositories/catalog_repository.dart';
import '../../core/state/app_session.dart';
import '../../core/theme/winger_colors.dart';
import '../../core/widgets/kpi_card.dart';
import '../../core/widgets/role_shell.dart';
import '../../core/widgets/status_badge.dart';
import '../onboarding/onboarding_checklist.dart';

List<ShellDestination> adminDestinations({int returnsAttention = 0}) => [
  const ShellDestination(labelKey: 'dashboard', icon: Icons.dashboard_outlined, path: '/admin'),
  const ShellDestination(labelKey: 'suppliers', icon: Icons.storefront_outlined, path: '/admin/suppliers'),
  const ShellDestination(labelKey: 'orders', icon: Icons.receipt_long_outlined, path: '/admin/orders'),
  ShellDestination(
    labelKey: 'returns',
    icon: Icons.assignment_return_outlined,
    path: '/admin/returns',
    badgeCount: returnsAttention,
  ),
  const ShellDestination(labelKey: 'commission', icon: Icons.percent_outlined, path: '/admin/commissions'),
  const ShellDestination(labelKey: 'delivery', icon: Icons.local_shipping_outlined, path: '/admin/delivery'),
  const ShellDestination(labelKey: 'currencies', icon: Icons.currency_exchange, path: '/admin/currencies'),
];

class AdminShell extends StatefulWidget {
  const AdminShell({super.key, required this.child});

  final Widget child;

  @override
  State<AdminShell> createState() => _AdminShellState();
}

class _AdminShellState extends State<AdminShell> {
  int _returnsAttention = 0;
  String? _lastPath;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _refreshReturnsBadge());
  }

  Future<void> _refreshReturnsBadge() async {
    if (!mounted) return;
    final session = context.read<AppSession>();
    final api = context.read<ApiClient>();
    if (session.accessToken == null || !session.apiOnline) {
      if (_returnsAttention != 0) setState(() => _returnsAttention = 0);
      return;
    }
    try {
      final overview = await api.fetchReturnsOverview();
      if (!mounted) return;
      final open = (overview['openReturns'] as num?)?.toInt() ?? 0;
      final pending = (overview['pendingRefunds'] as num?)?.toInt() ?? 0;
      final next = open + pending;
      if (next != _returnsAttention) {
        setState(() => _returnsAttention = next);
      }
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final location = GoRouterState.of(context).uri.path;
    if (_lastPath != location) {
      _lastPath = location;
      WidgetsBinding.instance.addPostFrameCallback((_) => _refreshReturnsBadge());
    }
    return RoleShell(
      title: s.t('dashboard'),
      roleLabel: 'Administrator',
      destinations: adminDestinations(returnsAttention: _returnsAttention),
      child: widget.child,
    );
  }
}

class AdminDashboardScreen extends StatelessWidget {
  const AdminDashboardScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final wide = MediaQuery.sizeOf(context).width >= 900;

    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        const OnboardingChecklistCard(journeyRoute: '/admin/onboarding'),
        Text(s.t('dashboard'), style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
        const SizedBox(height: 16),
        GridView.count(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          crossAxisCount: wide ? 4 : 2,
          mainAxisSpacing: 12,
          crossAxisSpacing: 12,
          childAspectRatio: wide ? 1.4 : 1.25,
          children: [for (final kpi in MockCatalog.adminKpis) KpiCard(data: kpi)],
        ),
        const SizedBox(height: 20),
        Text(s.t('operationalQueue'), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
        const SizedBox(height: 8),
        for (final item in const [
          ('Supplier reviews', '12'),
          ('Delivery exceptions', '17'),
          ('Payment holds', '5'),
          ('Catalogue approvals', '9'),
        ])
          Card(
            child: ListTile(
              title: Text(item.$1),
              trailing: CircleAvatar(
                radius: 16,
                backgroundColor: WingerColors.brandMuted,
                child: Text(item.$2, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w800)),
              ),
            ),
          ),
        const SizedBox(height: 12),
        Text(s.t('platformAlerts'), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
        const Card(
          child: ListTile(
            title: Text('Delivery · Late hub transfer'),
            subtitle: Text('Owner: Ops · SLA at risk'),
            trailing: Text('HIGH', style: TextStyle(color: WingerColors.dangerInk, fontWeight: FontWeight.w800)),
          ),
        ),
      ],
    );
  }
}

class AdminSuppliersScreen extends StatelessWidget {
  const AdminSuppliersScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    const suppliers = [
      ('Kijani Tech', '286 orders', 'LIVE'),
      ('Atlas Home', '142 orders', 'LIVE'),
      ('Metals Outdoor', '98 orders', 'REVIEW'),
    ];
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Text(s.t('suppliers'), style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
        const SizedBox(height: 12),
        for (final supplier in suppliers)
          Card(
            child: ListTile(
              title: Text(supplier.$1, style: const TextStyle(fontWeight: FontWeight.w700)),
              subtitle: Text(supplier.$2),
              trailing: Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                  color: supplier.$3 == 'LIVE' ? WingerColors.success : WingerColors.info,
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Text(
                  supplier.$3,
                  style: TextStyle(
                    fontWeight: FontWeight.w800,
                    fontSize: 12,
                    color: supplier.$3 == 'LIVE' ? WingerColors.successInk : WingerColors.infoInk,
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class AdminOrdersScreen extends StatefulWidget {
  const AdminOrdersScreen({super.key});

  @override
  State<AdminOrdersScreen> createState() => _AdminOrdersScreenState();
}

class _AdminOrdersScreenState extends State<AdminOrdersScreen> {
  Future<List<CustomerOrder>>? _future;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _future ??= _load();
  }

  Future<List<CustomerOrder>> _load() async {
    final session = context.read<AppSession>();
    final api = context.read<ApiClient>();
    if (session.apiOnline && session.accessToken != null) {
      return api.fetchOrders();
    }
    return [];
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final future = _future;
    if (future == null) {
      return const Center(child: CircularProgressIndicator());
    }

    return FutureBuilder<List<CustomerOrder>>(
      future: future,
      builder: (context, snapshot) {
        final orders = snapshot.data ?? [];
        return ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Text(s.t('orders'), style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
            const SizedBox(height: 12),
            if (snapshot.connectionState != ConnectionState.done)
              const Center(child: CircularProgressIndicator())
            else if (orders.isEmpty)
              Text('No orders in the platform yet.', style: TextStyle(color: WingerColors.muted))
            else
              for (final order in orders)
                Card(
                  child: ListTile(
                    title: Text(order.id, style: const TextStyle(fontWeight: FontWeight.w700)),
                    subtitle: Text(
                      '${order.customerName} · ${order.itemRows.length} line(s) · ${order.paymentStatus}',
                    ),
                    trailing: StatusBadge(status: order.status),
                  ),
                ),
          ],
        );
      },
    );
  }
}

class AdminDeliveryScreen extends StatelessWidget {
  const AdminDeliveryScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final order = MockCatalog.sampleOrder;
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Text(s.t('delivery'), style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
        const SizedBox(height: 12),
        Wrap(
          spacing: 12,
          runSpacing: 12,
          children: const [
            SizedBox(width: 160, child: KpiCard(data: KpiCardData(label: 'In transit', value: '1,284', delta: '+2.1%'))),
            SizedBox(width: 160, child: KpiCard(data: KpiCardData(label: 'Pickup ready', value: '218', delta: '+1.0%'))),
            SizedBox(
              width: 160,
              child: KpiCard(data: KpiCardData(label: 'Exceptions', value: '17', delta: 'attention', positive: false)),
            ),
          ],
        ),
        const SizedBox(height: 16),
        Text('Split shipment: ${order.id}', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
        const SizedBox(height: 8),
        for (final leg in order.shipments)
          Card(
            child: ListTile(
              title: Text(leg.supplierName, style: const TextStyle(fontWeight: FontWeight.w700)),
              subtitle: Text(leg.productName),
              trailing: StatusBadge(status: leg.status),
            ),
          ),
      ],
    );
  }
}

class _CommissionTotalChip extends StatelessWidget {
  const _CommissionTotalChip({
    required this.label,
    required this.value,
    this.emphasize = false,
  });

  final String label;
  final double value;
  final bool emphasize;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 160,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: emphasize ? WingerColors.brandMuted : WingerColors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: WingerColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: TextStyle(color: WingerColors.muted, fontSize: 12)),
          const SizedBox(height: 4),
          Text(
            '\$${value.toStringAsFixed(2)}',
            style: TextStyle(
              fontWeight: FontWeight.w900,
              fontSize: 18,
              color: emphasize ? WingerColors.brand : WingerColors.ink,
            ),
          ),
        ],
      ),
    );
  }
}

class AdminCommissionsScreen extends StatefulWidget {
  const AdminCommissionsScreen({super.key});

  @override
  State<AdminCommissionsScreen> createState() => _AdminCommissionsScreenState();
}

class _AdminCommissionsScreenState extends State<AdminCommissionsScreen> {
  Future<void>? _load;
  double _defaultRate = 10;
  final _rateCtrl = TextEditingController(text: '10');
  List<Map<String, dynamic>> _agreements = const [];
  List<CatalogSupplier> _suppliers = const [];
  Map<String, dynamic>? _supplierTotals;
  String? _proposeSupplierId;
  final _proposeRateCtrl = TextEditingController(text: '10');
  String? _error;
  bool _busy = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _load ??= _reload();
  }

  @override
  void dispose() {
    _rateCtrl.dispose();
    _proposeRateCtrl.dispose();
    super.dispose();
  }

  Future<void> _reload() async {
    final api = context.read<ApiClient>();
    final catalog = context.read<CatalogRepository>();
    try {
      final settings = await api.fetchCommissionSettings();
      final agreements = await api.fetchCommissionAgreements();
      final totals = await api.fetchAdminSupplierCommissionTotals();
      final suppliers = await catalog.getSuppliers();
      if (!mounted) return;
      setState(() {
        _defaultRate = (settings['defaultCommissionPercent'] as num?)?.toDouble() ?? 10;
        _rateCtrl.text = _defaultRate.toString();
        _agreements = agreements;
        _supplierTotals = totals;
        _suppliers = suppliers;
        _proposeSupplierId ??= suppliers.isNotEmpty ? suppliers.first.id : null;
        _error = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    }
  }

  Future<void> _saveDefault() async {
    final parsed = double.tryParse(_rateCtrl.text.trim());
    if (parsed == null) return;
    setState(() => _busy = true);
    try {
      await context.read<ApiClient>().updateDefaultCommissionRate(parsed);
      await _reload();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(WingerStrings.of(context).t('commissionDefaultSaved'))),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(e.toString().replaceFirst('Exception: ', ''))),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _propose() async {
    final supplierId = _proposeSupplierId;
    final rate = double.tryParse(_proposeRateCtrl.text.trim());
    if (supplierId == null || rate == null) return;
    setState(() => _busy = true);
    try {
      await context.read<ApiClient>().proposeCommissionAgreement(
            supplierId: supplierId,
            ratePercent: rate,
          );
      await _reload();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(e.toString().replaceFirst('Exception: ', ''))),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _action(String id, String action) async {
    final s = WingerStrings.of(context);
    setState(() => _busy = true);
    try {
      await context.read<ApiClient>().commissionAgreementAction(
            agreementId: id,
            action: action,
          );
      await _reload();
      if (!mounted) return;
      if (action == 'approve') {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(s.t('awaitingSupplierAccept'))),
        );
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(e.toString().replaceFirst('Exception: ', ''))),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    return FutureBuilder(
      future: _load,
      builder: (context, snapshot) {
        return ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Text(s.t('commission'), style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
            const SizedBox(height: 8),
            Text(s.t('commissionAdminHint'), style: TextStyle(color: WingerColors.muted)),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!, style: const TextStyle(color: WingerColors.dangerInk)),
            ],
            const SizedBox(height: 16),
            Text(s.t('commissionBySupplier'), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
            const SizedBox(height: 4),
            Text(s.t('commissionBySupplierHint'), style: TextStyle(color: WingerColors.muted)),
            const SizedBox(height: 10),
            if (_supplierTotals != null) ...[
              Builder(
                builder: (context) {
                  final totals = (_supplierTotals!['totals'] as Map<String, dynamic>?) ?? {};
                  final rows = (_supplierTotals!['suppliers'] as List<dynamic>? ?? const [])
                      .cast<Map<String, dynamic>>();
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Wrap(
                        spacing: 12,
                        runSpacing: 12,
                        children: [
                          _CommissionTotalChip(
                            label: s.t('pendingCommission'),
                            value: (totals['pendingCommission'] as num?)?.toDouble() ?? 0,
                          ),
                          _CommissionTotalChip(
                            label: s.t('recognizedCommission'),
                            value: (totals['recognizedCommission'] as num?)?.toDouble() ?? 0,
                          ),
                          _CommissionTotalChip(
                            label: s.t('settleableCommission'),
                            value: (totals['settleableCommission'] as num?)?.toDouble() ?? 0,
                          ),
                          _CommissionTotalChip(
                            label: s.t('totalCommission'),
                            value: (totals['totalCommission'] as num?)?.toDouble() ?? 0,
                            emphasize: true,
                          ),
                          _CommissionTotalChip(
                            label: s.t('demoCommission'),
                            value: (totals['demoCommission'] as num?)?.toDouble() ?? 0,
                          ),
                        ],
                      ),
                      if (((totals['demoCommission'] as num?)?.toDouble() ?? 0) > 0) ...[
                        const SizedBox(height: 8),
                        Text(
                          s.t('demoCommissionNote'),
                          style: TextStyle(color: WingerColors.muted, fontWeight: FontWeight.w600),
                        ),
                      ],
                      const SizedBox(height: 12),
                      if (rows.isEmpty)
                        Text(s.t('noCommissionLines'), style: TextStyle(color: WingerColors.muted))
                      else
                        for (final row in rows)
                          Card(
                            child: ListTile(
                              title: Text(
                                '${row['supplierName'] ?? row['supplierId']}',
                                style: const TextStyle(fontWeight: FontWeight.w800),
                              ),
                              subtitle: Text(
                                '${s.t('activeRate')}: ${(row['activeRatePercent'] as num?)?.toStringAsFixed(1) ?? '—'}%'
                                '${row['usingDefaultRate'] == true ? ' (${s.t('defaultCommission')})' : ''}\n'
                                '${s.t('pending')}: \$${((row['pendingCommission'] as num?)?.toDouble() ?? 0).toStringAsFixed(2)} · '
                                '${s.t('recognized')}: \$${((row['recognizedCommission'] as num?)?.toDouble() ?? 0).toStringAsFixed(2)} · '
                                '${s.t('settleable')}: \$${((row['settleableCommission'] as num?)?.toDouble() ?? 0).toStringAsFixed(2)} · '
                                '${s.t('lines')}: ${row['lineCount'] ?? 0}'
                                '${((row['demoCommission'] as num?)?.toDouble() ?? 0) > 0 ? '\n${s.t('demoCommission')}: \$${((row['demoCommission'] as num?)?.toDouble() ?? 0).toStringAsFixed(2)} (${row['demoLineCount'] ?? 0} ${s.t('lines')})' : ''}',
                              ),
                              isThreeLine: true,
                              trailing: Column(
                                mainAxisAlignment: MainAxisAlignment.center,
                                crossAxisAlignment: CrossAxisAlignment.end,
                                children: [
                                  Text(
                                    '\$${((row['totalCommission'] as num?)?.toDouble() ?? 0).toStringAsFixed(2)}',
                                    style: const TextStyle(fontWeight: FontWeight.w900, fontSize: 16),
                                  ),
                                  if (((row['demoCommission'] as num?)?.toDouble() ?? 0) > 0)
                                    Text(
                                      'demo \$${((row['demoCommission'] as num?)?.toDouble() ?? 0).toStringAsFixed(2)}',
                                      style: TextStyle(color: WingerColors.muted, fontSize: 11),
                                    ),
                                ],
                              ),
                            ),
                          ),
                    ],
                  );
                },
              ),
            ],
            const SizedBox(height: 16),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(s.t('defaultCommission'), style: const TextStyle(fontWeight: FontWeight.w800)),
                    const SizedBox(height: 8),
                    Row(
                      children: [
                        SizedBox(
                          width: 120,
                          child: TextField(
                            controller: _rateCtrl,
                            keyboardType: const TextInputType.numberWithOptions(decimal: true),
                            decoration: InputDecoration(suffixText: '%', labelText: s.t('commissionRate')),
                          ),
                        ),
                        const SizedBox(width: 12),
                        FilledButton(
                          onPressed: _busy ? null : _saveDefault,
                          child: Text(s.t('save')),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),
            Text(s.t('proposeAgreement'), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
            const SizedBox(height: 8),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  children: [
                    DropdownButtonFormField<String>(
                      value: _proposeSupplierId,
                      items: [
                        for (final supplier in _suppliers)
                          DropdownMenuItem(value: supplier.id, child: Text(supplier.name)),
                      ],
                      onChanged: (value) => setState(() => _proposeSupplierId = value),
                      decoration: InputDecoration(labelText: s.t('suppliers')),
                    ),
                    const SizedBox(height: 8),
                    TextField(
                      controller: _proposeRateCtrl,
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      decoration: InputDecoration(suffixText: '%', labelText: s.t('commissionRate')),
                    ),
                    const SizedBox(height: 8),
                    Align(
                      alignment: Alignment.centerRight,
                      child: FilledButton(
                        onPressed: _busy ? null : _propose,
                        child: Text(s.t('proposeAgreement')),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),
            Text(s.t('commissionAgreements'), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
            const SizedBox(height: 8),
            if (snapshot.connectionState != ConnectionState.done)
              const Center(child: CircularProgressIndicator())
            else if (_agreements.isEmpty)
              Text(s.t('noAgreements'), style: TextStyle(color: WingerColors.muted))
            else
              for (final row in _agreements)
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '${row['supplierName'] ?? row['supplierId']} · ${row['status']}',
                          style: const TextStyle(fontWeight: FontWeight.w800),
                        ),
                        Text(
                          '${s.t('proposed')}: ${row['proposedRatePercent']}%'
                          '${row['counterRatePercent'] != null ? ' · ${s.t('counter')}: ${row['counterRatePercent']}%' : ''}'
                          '${row['effectiveRatePercent'] != null ? ' · ${s.t('effective')}: ${row['effectiveRatePercent']}%' : ''}',
                        ),
                        const SizedBox(height: 8),
                        Wrap(
                          spacing: 8,
                          children: [
                            if (row['status'] == 'PROPOSED' || row['status'] == 'COUNTERED')
                              FilledButton(
                                onPressed: _busy ? null : () => _action(row['id'] as String, 'approve'),
                                child: Text(s.t('approve')),
                              ),
                            if (row['status'] == 'APPROVED')
                              Text(
                                s.t('awaitingSupplierAccept'),
                                style: TextStyle(color: WingerColors.muted, fontWeight: FontWeight.w600),
                              ),
                            if (row['status'] != 'ACTIVE' &&
                                row['status'] != 'REJECTED' &&
                                row['status'] != 'SUPERSEDED')
                              OutlinedButton(
                                onPressed: _busy ? null : () => _action(row['id'] as String, 'reject'),
                                child: Text(s.t('reject')),
                              ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
          ],
        );
      },
    );
  }
}

class AdminCurrencyScreen extends StatefulWidget {
  const AdminCurrencyScreen({super.key});

  @override
  State<AdminCurrencyScreen> createState() => _AdminCurrencyScreenState();
}

class _AdminCurrencyScreenState extends State<AdminCurrencyScreen> {
  final _settlement = TextEditingController();
  final _maxAgeHours = TextEditingController();
  final _newDisplay = TextEditingController();
  final _newQuote = TextEditingController();
  final _newRate = TextEditingController();
  final Map<String, TextEditingController> _rateFields = {};

  List<String> _display = [];
  List<String> _payment = [];
  List<Map<String, dynamic>> _rates = [];
  bool _loading = true;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  @override
  void dispose() {
    _settlement.dispose();
    _maxAgeHours.dispose();
    _newDisplay.dispose();
    _newQuote.dispose();
    _newRate.dispose();
    for (final field in _rateFields.values) {
      field.dispose();
    }
    super.dispose();
  }

  List<String> _codes(dynamic value) {
    if (value is! List) return [];
    return value.map((item) => item.toString().toUpperCase()).toList();
  }

  void _apply(Map<String, dynamic> config, List<Map<String, dynamic>> rates) {
    final settlement = (config['settlementCurrency'] as String? ?? 'USD').toUpperCase();
    final seconds = (config['fxMaxAgeSeconds'] as num?)?.toInt() ?? 86400;
    final hours = seconds / 3600;
    _settlement.text = settlement;
    _maxAgeHours.text = hours == hours.roundToDouble()
        ? hours.toStringAsFixed(0)
        : hours.toStringAsFixed(1);
    _display = _codes(config['supportedDisplayCurrencies']);
    _payment = _codes(config['supportedPaymentCurrencies']);
    if (!_display.contains(settlement)) _display.insert(0, settlement);
    if (!_payment.contains(settlement)) _payment.insert(0, settlement);
    for (final field in _rateFields.values) {
      field.dispose();
    }
    _rateFields.clear();
    for (final row in rates) {
      final quote = (row['quoteCurrency'] as String? ?? '').toUpperCase();
      final rate = row['rate'];
      _rateFields[quote] = TextEditingController(text: '$rate');
    }
    _rates = rates;
    _loading = false;
    _error = null;
  }

  Future<void> _saveSettings() async {
    final s = WingerStrings.of(context);
    final settlement = _settlement.text.trim().toUpperCase();
    final hours = double.tryParse(_maxAgeHours.text.trim());
    if (!RegExp(r'^[A-Z]{3}$').hasMatch(settlement) || hours == null || hours <= 0) {
      setState(() => _error = s.t('currencyHint'));
      return;
    }
    final display = [..._display];
    if (!display.contains(settlement)) display.insert(0, settlement);
    final payment = _payment.where(display.contains).toList();
    if (!payment.contains(settlement)) payment.insert(0, settlement);
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final api = context.read<ApiClient>();
      await api.updateFxSettings(
        settlementCurrency: settlement,
        supportedDisplayCurrencies: display,
        supportedPaymentCurrencies: payment,
        fxMaxAgeSeconds: (hours * 3600).round(),
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(s.t('currencySaved'))));
      await _load();
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _saveRate(String quote, String raw) async {
    final s = WingerStrings.of(context);
    final rate = double.tryParse(raw.trim());
    final code = quote.trim().toUpperCase();
    if (!RegExp(r'^[A-Z]{3}$').hasMatch(code) || rate == null || rate <= 0) {
      setState(() => _error = s.t('currencyHint'));
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final api = context.read<ApiClient>();
      await api.upsertFxRate(
        quoteCurrency: code,
        rate: rate,
        baseCurrency: _settlement.text.trim().toUpperCase(),
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(s.t('rateSaved'))));
      _newQuote.clear();
      _newRate.clear();
      await _load();
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final api = context.read<ApiClient>();
      final config = await api.fetchFxConfig();
      final rates = await api.fetchFxRates();
      if (!mounted) return;
      setState(() => _apply(config, rates));
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = error.toString().replaceFirst('Exception: ', '');
      });
    }
  }

  void _addDisplay() {
    final code = _newDisplay.text.trim().toUpperCase();
    if (!RegExp(r'^[A-Z]{3}$').hasMatch(code)) return;
    setState(() {
      if (!_display.contains(code)) _display.add(code);
      _newDisplay.clear();
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Text(s.t('currencies'), style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
        const SizedBox(height: 8),
        Text(s.t('currencyHint'), style: const TextStyle(color: WingerColors.muted)),
        const SizedBox(height: 16),
        if (_loading)
          const Center(child: CircularProgressIndicator())
        else ...[
          if (_error != null) ...[
            Text(_error!, style: const TextStyle(color: WingerColors.dangerInk)),
            const SizedBox(height: 12),
          ],
          TextField(
            controller: _settlement,
            textCapitalization: TextCapitalization.characters,
            decoration: InputDecoration(labelText: s.t('settlementCurrency')),
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: 16),
          Text(s.t('displayCurrencies'), style: const TextStyle(fontWeight: FontWeight.w800)),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final code in _display)
                InputChip(
                  label: Text(code),
                  onDeleted: code == _settlement.text.trim().toUpperCase()
                      ? null
                      : () => setState(() {
                            _display.remove(code);
                            _payment.remove(code);
                          }),
                ),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              SizedBox(
                width: 140,
                child: TextField(
                  controller: _newDisplay,
                  textCapitalization: TextCapitalization.characters,
                  decoration: InputDecoration(labelText: s.t('quoteCurrency')),
                ),
              ),
              const SizedBox(width: 8),
              FilledButton(onPressed: _addDisplay, child: Text(s.t('addCurrency'))),
            ],
          ),
          const SizedBox(height: 16),
          Text(s.t('paymentCurrencies'), style: const TextStyle(fontWeight: FontWeight.w800)),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            children: [
              for (final code in _display)
                FilterChip(
                  label: Text(code),
                  selected: _payment.contains(code),
                  onSelected: code == _settlement.text.trim().toUpperCase()
                      ? null
                      : (selected) => setState(() {
                            if (selected) {
                              if (!_payment.contains(code)) _payment.add(code);
                            } else {
                              _payment.remove(code);
                            }
                          }),
                ),
            ],
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _maxAgeHours,
            keyboardType: TextInputType.number,
            decoration: InputDecoration(labelText: s.t('fxMaxAgeHours')),
          ),
          const SizedBox(height: 12),
          FilledButton(
            onPressed: _saving ? null : _saveSettings,
            child: Text(s.t('saveCurrencies')),
          ),
          const SizedBox(height: 24),
          Text(s.t('exchangeRates'), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
          const SizedBox(height: 8),
          for (final row in _rates)
            Card(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Row(
                  children: [
                    Text(
                      '1 ${row['baseCurrency']} = ',
                      style: const TextStyle(fontWeight: FontWeight.w700),
                    ),
                    const SizedBox(width: 8),
                    SizedBox(
                      width: 140,
                      child: TextField(
                        controller: _rateFields[(row['quoteCurrency'] as String).toUpperCase()],
                        keyboardType: const TextInputType.numberWithOptions(decimal: true),
                        decoration: InputDecoration(
                          labelText: (row['quoteCurrency'] as String).toUpperCase(),
                        ),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Text(
                      row['fresh'] == true ? s.t('rateFresh') : s.t('rateExpired'),
                      style: TextStyle(
                        color: row['fresh'] == true ? WingerColors.successInk : WingerColors.attentionInk,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(width: 12),
                    FilledButton(
                      onPressed: _saving
                          ? null
                          : () {
                              final quote = (row['quoteCurrency'] as String).toUpperCase();
                              _saveRate(quote, _rateFields[quote]?.text ?? '');
                            },
                      child: Text(s.t('saveRate')),
                    ),
                  ],
                ),
              ),
            ),
          const SizedBox(height: 8),
          Row(
            children: [
              SizedBox(
                width: 140,
                child: TextField(
                  controller: _newQuote,
                  textCapitalization: TextCapitalization.characters,
                  decoration: InputDecoration(labelText: s.t('quoteCurrency')),
                ),
              ),
              const SizedBox(width: 8),
              SizedBox(
                width: 140,
                child: TextField(
                  controller: _newRate,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  decoration: InputDecoration(labelText: s.t('saveRate')),
                ),
              ),
              const SizedBox(width: 8),
              FilledButton(
                onPressed: _saving ? null : () => _saveRate(_newQuote.text, _newRate.text),
                child: Text(s.t('addRate')),
              ),
            ],
          ),
        ],
      ],
    );
  }
}
