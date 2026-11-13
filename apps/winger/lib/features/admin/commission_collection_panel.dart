import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/l10n/winger_strings.dart';
import '../../core/theme/winger_colors.dart';

class AdminCommissionCollectionPanel extends StatefulWidget {
  const AdminCommissionCollectionPanel({super.key});

  @override
  State<AdminCommissionCollectionPanel> createState() =>
      _AdminCommissionCollectionPanelState();
}

class _AdminCommissionCollectionPanelState
    extends State<AdminCommissionCollectionPanel> {
  Map<String, dynamic>? _accounts;
  Map<String, dynamic>? _held;
  List<dynamic> _remittances = const [];
  String? _error;
  bool _busy = false;
  bool _started = false;
  final _lipa = TextEditingController();
  final _network = TextEditingController();
  final _bankName = TextEditingController();
  final _bankAccountName = TextEditingController();
  final _bankAccount = TextEditingController();
  final _reason = TextEditingController();

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    _load();
  }

  @override
  void dispose() {
    _lipa.dispose();
    _network.dispose();
    _bankName.dispose();
    _bankAccountName.dispose();
    _bankAccount.dispose();
    _reason.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final api = context.read<ApiClient>();
    try {
      final accounts = await api.fetchAdminCommissionAccounts();
      final held = await api.fetchHeldFunds();
      final receiving = await api.fetchReceivingAccounts();
      final remittances = await api.fetchAdminRemittances();
      if (!mounted) return;
      _lipa.text = '${receiving['lipaNumber'] ?? ''}';
      _network.text = '${receiving['lipaNetwork'] ?? ''}';
      _bankName.text = '${receiving['bankName'] ?? ''}';
      _bankAccountName.text = '${receiving['bankAccountName'] ?? ''}';
      _bankAccount.text = '${receiving['bankAccountNumber'] ?? ''}';
      setState(() {
        _accounts = accounts;
        _held = held;
        _remittances = remittances;
        _error = null;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error.toString().replaceFirst('Exception: ', ''));
    }
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() => _busy = true);
    try {
      await action();
      await _load();
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(error.toString().replaceFirst('Exception: ', ''))),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final suppliers = (_accounts?['suppliers'] as List?) ?? const [];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(s.t('commissionAccount'),
            style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
        if (_error != null)
          Text(_error!, style: TextStyle(color: WingerColors.dangerInk)),
        const SizedBox(height: 8),
        Text(s.t('receivingAccounts'),
            style: const TextStyle(fontWeight: FontWeight.w700)),
        TextField(controller: _lipa, decoration: const InputDecoration(labelText: 'Lipa number')),
        TextField(controller: _network, decoration: const InputDecoration(labelText: 'Network')),
        TextField(controller: _bankName, decoration: const InputDecoration(labelText: 'Bank')),
        TextField(controller: _bankAccountName, decoration: const InputDecoration(labelText: 'Account name')),
        TextField(controller: _bankAccount, decoration: const InputDecoration(labelText: 'Account number')),
        FilledButton(
          onPressed: _busy
              ? null
              : () => _run(() => context.read<ApiClient>().saveReceivingAccounts({
                    'lipaNumber': _lipa.text.trim(),
                    'lipaNetwork': _network.text.trim(),
                    'bankName': _bankName.text.trim(),
                    'bankAccountName': _bankAccountName.text.trim(),
                    'bankAccountNumber': _bankAccount.text.trim(),
                  })),
          child: Text(s.t('save')),
        ),
        const SizedBox(height: 12),
        Text(s.t('heldFunds'), style: const TextStyle(fontWeight: FontWeight.w700)),
        if (_held != null)
          Text(
            'Merchandise ${_held!['merchandiseSales']} · Tax held ${_held!['taxHeld']} · Delivery ${_held!['deliveryChargesCollected']} · Retained commission ${_held!['commissionRetained']}',
          ),
        const SizedBox(height: 12),
        for (final supplier in suppliers)
          if (supplier is Map)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text(
                '${supplier['supplierName']}: due ${supplier['netAmountDue']} · outstanding ${supplier['grossCommissionOutstanding']} · collected ${supplier['cashCommissionCollected']} · unapplied cash ${supplier['unappliedVerifiedCash']} · credit ${supplier['unappliedRefundCredit']}',
              ),
            ),
        TextField(
          controller: _reason,
          decoration: InputDecoration(labelText: s.t('reverseRemittance')),
        ),
        for (final row in _remittances)
          if (row is Map)
            ListTile(
              title: Text(
                '${row['supplierId']} · ${row['status']} · ${row['claimedAmount']} ${row['claimedCurrency']} · ${row['reference']}',
              ),
              subtitle: Text(
                'Allocated ${row['allocated'] ?? 0} · unapplied ${row['unapplied'] ?? 0}',
              ),
              trailing: row['status'] == 'SUBMITTED' || row['status'] == 'UNDER_REVIEW'
                  ? Wrap(
                      spacing: 8,
                      children: [
                        TextButton(
                          onPressed: _busy
                              ? null
                              : () => _run(() async {
                                    final api = context.read<ApiClient>();
                                    final preview = await api.previewRemittanceFx('${row['id']}');
                                    if (!context.mounted) return;
                                    final confirmed = await showDialog<bool>(
                                      context: context,
                                      builder: (context) => AlertDialog(
                                        title: Text(s.t('verifyPayment')),
                                        content: Text(
                                          '${preview['claimedAmount']} ${preview['claimedCurrency']} = ${preview['verifiedAmountUsd']} USD (${preview['fxSource']})',
                                        ),
                                        actions: [
                                          TextButton(
                                            onPressed: () => Navigator.pop(context, false),
                                            child: Text(s.t('cancel')),
                                          ),
                                          TextButton(
                                            onPressed: () => Navigator.pop(context, true),
                                            child: Text(s.t('verifyPayment')),
                                          ),
                                        ],
                                      ),
                                    );
                                    if (confirmed != true) return;
                                    await api.verifyCommissionRemittance(
                                      '${row['id']}',
                                      confirmExchange: preview['claimedCurrency'] != 'USD',
                                    );
                                  }),
                          child: Text(s.t('verifyPayment')),
                        ),
                        TextButton(
                          onPressed: _busy
                              ? null
                              : () => _run(() => context.read<ApiClient>().rejectCommissionRemittance(
                                    '${row['id']}',
                                    _reason.text.trim().isEmpty
                                        ? 'Rejected'
                                        : _reason.text.trim(),
                                  )),
                          child: Text(s.t('reject')),
                        ),
                      ],
                    )
                  : row['status'] == 'VERIFIED'
                      ? TextButton(
                          onPressed: _busy
                              ? null
                              : () => _run(() => context.read<ApiClient>().reverseCommissionRemittance(
                                    '${row['id']}',
                                    _reason.text.trim(),
                                  )),
                          child: Text(s.t('reverseRemittance')),
                        )
                      : null,
            ),
        const SizedBox(height: 16),
      ],
    );
  }
}
