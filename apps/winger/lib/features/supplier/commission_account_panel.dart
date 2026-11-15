import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/l10n/winger_strings.dart';
import '../../core/theme/winger_colors.dart';

class SupplierCommissionAccountPanel extends StatefulWidget {
  const SupplierCommissionAccountPanel({super.key});

  @override
  State<SupplierCommissionAccountPanel> createState() =>
      _SupplierCommissionAccountPanelState();
}

class _SupplierCommissionAccountPanelState
    extends State<SupplierCommissionAccountPanel> {
  Map<String, dynamic>? _account;
  Map<String, dynamic>? _accounts;
  List<dynamic> _remittances = const [];
  List<dynamic> _lipaEvidence = const [];
  String? _error;
  bool _busy = false;
  bool _started = false;
  final _amount = TextEditingController();
  final _currency = TextEditingController(text: 'USD');
  final _reference = TextEditingController();
  final _orderId = TextEditingController();
  final _evidenceRef = TextEditingController();
  String _method = 'WINGER_LIPA';

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    _load();
  }

  @override
  void dispose() {
    _amount.dispose();
    _currency.dispose();
    _reference.dispose();
    _orderId.dispose();
    _evidenceRef.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final api = context.read<ApiClient>();
    try {
      final account = await api.fetchSupplierCommissionAccount();
      final accounts = await api.fetchSupplierReceivingAccounts();
      final remittances = await api.fetchSupplierRemittances();
      final lipaEvidence = await api.fetchSupplierLipaEvidence();
      if (!mounted) return;
      setState(() {
        _account = account;
        _accounts = accounts;
        _remittances = remittances;
        _lipaEvidence = lipaEvidence;
        _error = null;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error.toString().replaceFirst('Exception: ', ''));
    }
  }

  Future<void> _submit() async {
    final amount = double.tryParse(_amount.text.trim());
    if (amount == null) return;
    setState(() => _busy = true);
    try {
      await context.read<ApiClient>().submitCommissionRemittance(
            method: _method,
            claimedAmount: amount,
            claimedCurrency: _currency.text.trim(),
            reference: _reference.text.trim(),
          );
      _reference.clear();
      await _load();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(WingerStrings.of(context).t('awaitingReview'))),
      );
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(error.toString().replaceFirst('Exception: ', ''))),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _submitEvidence() async {
    final orderId = _orderId.text.trim();
    final reference = _evidenceRef.text.trim();
    final s = WingerStrings.of(context);
    if (orderId.isEmpty || reference.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            orderId.isEmpty ? s.t('orderIdRequired') : s.t('paymentReferenceRequired'),
          ),
        ),
      );
      return;
    }
    setState(() => _busy = true);
    try {
      await context.read<ApiClient>().submitLipaEvidence(
            orderId: orderId,
            reference: reference,
          );
      _evidenceRef.clear();
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
    final account = _account;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(s.t('commissionAccount'),
            style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
        const SizedBox(height: 8),
        if (_error != null)
          Text(_error!, style: TextStyle(color: WingerColors.dangerInk)),
        if (account != null)
          Wrap(
            spacing: 16,
            runSpacing: 8,
            children: [
              _line(s.t('pendingRecognition'), account['pendingRecognition']),
              _line(s.t('recognisedAwaitingDelivery'), account['recognisedAwaitingDelivery']),
              _line(s.t('earnedRetained'), account['earnedRetained']),
              _line(s.t('grossOutstanding'), account['grossCommissionOutstanding']),
              _line(s.t('cashCollected'), account['cashCommissionCollected']),
              _line(s.t('unappliedCash'), account['unappliedVerifiedCash']),
              _line(s.t('appliedCredit'), account['appliedRefundCredit']),
              _line(s.t('unappliedCredit'), account['unappliedRefundCredit']),
              _line(s.t('netAmountDue'), account['netAmountDue']),
            ],
          ),
        if (_accounts != null) ...[
          const SizedBox(height: 8),
          Text(
            '${s.t('receivingAccounts')}: Lipa ${_accounts!['lipaNumber'] ?? ''} · Bank ${_accounts!['bankAccountNumber'] ?? ''}',
            style: TextStyle(color: WingerColors.muted),
          ),
        ],
        const SizedBox(height: 12),
        Text(s.t('submitCommissionPayment'),
            style: const TextStyle(fontWeight: FontWeight.w700)),
        const SizedBox(height: 8),
        DropdownButton<String>(
          value: _method,
          items: const [
            DropdownMenuItem(value: 'WINGER_LIPA', child: Text('Lipa')),
            DropdownMenuItem(value: 'BANK_TRANSFER', child: Text('Bank')),
          ],
          onChanged: _busy ? null : (value) => setState(() => _method = value ?? _method),
        ),
        TextField(controller: _amount, decoration: const InputDecoration(labelText: 'Amount')),
        TextField(controller: _currency, decoration: const InputDecoration(labelText: 'Currency')),
        TextField(
          controller: _reference,
          decoration: InputDecoration(labelText: s.t('paymentReference')),
        ),
        const SizedBox(height: 8),
        FilledButton(
          onPressed: _busy ? null : _submit,
          child: Text(s.t('submitCommissionPayment')),
        ),
        const SizedBox(height: 16),
        Text(s.t('lipaEvidenceTitle'),
            style: const TextStyle(fontWeight: FontWeight.w700)),
        TextField(
          key: const ValueKey('lipa-evidence-order'),
          controller: _orderId,
          decoration: InputDecoration(labelText: s.t('lipaEvidenceOrderId')),
        ),
        TextField(
          key: const ValueKey('lipa-evidence-reference'),
          controller: _evidenceRef,
          decoration: InputDecoration(labelText: s.t('lipaEvidenceReference')),
        ),
        Align(
          alignment: Alignment.centerLeft,
          child: OutlinedButton(
            onPressed: _busy ? null : _submitEvidence,
            child: Text(s.t('lipaEvidenceTitle')),
          ),
        ),
        const SizedBox(height: 12),
        Text(s.t('lipaEvidenceHistory'),
            style: const TextStyle(fontWeight: FontWeight.w700)),
        if (_lipaEvidence.isEmpty)
          Text(s.t('lipaEvidenceEmpty'), style: TextStyle(color: WingerColors.muted)),
        for (final row in _lipaEvidence)
          if (row is Map) _evidenceHistoryTile(s, row),
        const SizedBox(height: 12),
        for (final row in _remittances)
          if (row is Map)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Text(
                '${row['status']} · ${row['claimedAmount']} ${row['claimedCurrency']} · ${row['reference']}'
                '${row['status'] == 'VERIFIED' ? ' · collected ${row['allocated']} · unapplied ${row['unapplied']}' : ''}',
              ),
            ),
        const SizedBox(height: 20),
      ],
    );
  }

  String _evidenceStatusLabel(WingerStrings s, String status) {
    return switch (status) {
      'SUBMITTED' => s.t('evidenceStatusSubmitted'),
      'UNDER_REVIEW' => s.t('evidenceStatusUnderReview'),
      'VERIFIED' => s.t('evidenceStatusVerified'),
      'REJECTED' => s.t('evidenceStatusRejected'),
      _ => status,
    };
  }

  Widget _evidenceHistoryTile(WingerStrings s, Map row) {
    final note = '${row['reviewNote'] ?? ''}'.trim();
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Text(
        [
          '${row['orderNumber']} · ${_evidenceStatusLabel(s, '${row['status']}')}',
          '${row['reference']}',
          '${row['submittedAt']}',
          if (note.isNotEmpty) '${s.t('lipaEvidenceRejectNote')}: $note',
        ].join('\n'),
      ),
    );
  }

  Widget _line(String label, Object? value) {
    final amount = value is num ? value.toDouble() : 0;
    return Text('$label: \$${amount.toStringAsFixed(2)}');
  }
}
