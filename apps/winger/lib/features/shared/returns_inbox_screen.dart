import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/l10n/winger_strings.dart';
import '../../core/models/models.dart';
import '../../core/theme/winger_colors.dart';

class ReturnsInboxScreen extends StatefulWidget {
  const ReturnsInboxScreen({super.key});

  @override
  State<ReturnsInboxScreen> createState() => _ReturnsInboxScreenState();
}

class _ReturnsInboxScreenState extends State<ReturnsInboxScreen> {
  Future<List<OrderReturnRequest>>? _future;
  String? _busyId;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _future ??= _load();
  }

  Future<List<OrderReturnRequest>> _load() {
    return context.read<ApiClient>().fetchReturnsInbox();
  }

  String _reasonLabel(WingerStrings s, String reason) {
    switch (reason) {
      case 'damaged':
        return s.t('returnReasonDamaged');
      case 'wrong_item':
        return s.t('returnReasonWrongItem');
      case 'not_as_described':
        return s.t('returnReasonNotAsDescribed');
      case 'changed_mind':
        return s.t('returnReasonChangedMind');
      default:
        return s.t('returnReasonOther');
    }
  }

  Future<void> _setStatus(OrderReturnRequest request, String status) async {
    final s = WingerStrings.of(context);
    setState(() => _busyId = request.id);
    try {
      await context.read<ApiClient>().updateReturnRequest(
            returnId: request.id,
            status: status,
          );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(s.t('returnUpdated'))),
      );
      setState(() => _future = _load());
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(error.toString().replaceFirst('Exception: ', ''))),
      );
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final future = _future;
    if (future == null) {
      return const Center(child: CircularProgressIndicator());
    }

    return FutureBuilder<List<OrderReturnRequest>>(
      future: future,
      builder: (context, snapshot) {
        final rows = snapshot.data ?? const <OrderReturnRequest>[];
        return ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Text(
              s.t('returns'),
              style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 8),
            Text(
              s.t('returnsInboxHint'),
              style: TextStyle(color: WingerColors.muted),
            ),
            const SizedBox(height: 16),
            if (snapshot.connectionState != ConnectionState.done)
              const Center(child: CircularProgressIndicator())
            else if (snapshot.hasError)
              Text(
                snapshot.error.toString().replaceFirst('Exception: ', ''),
                style: const TextStyle(color: WingerColors.dangerInk),
              )
            else if (rows.isEmpty)
              Text(s.t('returnsEmpty'), style: TextStyle(color: WingerColors.muted))
            else
              for (final request in rows)
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(14),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Expanded(
                              child: Text(
                                request.productName,
                                style: const TextStyle(fontWeight: FontWeight.w800),
                              ),
                            ),
                            Text(
                              request.status,
                              style: const TextStyle(fontWeight: FontWeight.w700),
                            ),
                          ],
                        ),
                        const SizedBox(height: 4),
                        Text(
                          [
                            if (request.orderId != null) request.orderId!,
                            if (request.customerName != null) request.customerName!,
                            request.supplierName,
                            'qty ${request.quantity}',
                          ].join(' · '),
                        ),
                        Text(_reasonLabel(s, request.reason)),
                        if (request.notes != null && request.notes!.isNotEmpty)
                          Text(request.notes!, style: TextStyle(color: WingerColors.muted)),
                        if (request.canReview) ...[
                          const SizedBox(height: 10),
                          Wrap(
                            spacing: 8,
                            runSpacing: 8,
                            children: [
                              if (request.status == 'REQUESTED')
                                OutlinedButton(
                                  onPressed: _busyId == request.id
                                      ? null
                                      : () => _setStatus(request, 'IN_REVIEW'),
                                  child: Text(s.t('returnMarkReview')),
                                ),
                              FilledButton(
                                onPressed: _busyId == request.id
                                    ? null
                                    : () => _setStatus(request, 'APPROVED'),
                                child: Text(s.t('returnApprove')),
                              ),
                              OutlinedButton(
                                onPressed: _busyId == request.id
                                    ? null
                                    : () => _setStatus(request, 'REJECTED'),
                                child: Text(s.t('returnReject')),
                              ),
                            ],
                          ),
                        ] else if (request.status == 'APPROVED' ||
                            request.status == 'REJECTED') ...[
                          const SizedBox(height: 10),
                          TextButton(
                            onPressed: _busyId == request.id
                                ? null
                                : () => _setStatus(request, 'CLOSED'),
                            child: Text(s.t('returnClose')),
                          ),
                        ],
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
