import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../l10n/winger_strings.dart';
import '../theme/winger_colors.dart';

class CourierTripLines extends StatelessWidget {
  const CourierTripLines({
    super.key,
    this.driverName,
    this.driverPhone,
    this.plateNumber,
    this.fee,
    this.trackingUrl,
  });

  final String? driverName;
  final String? driverPhone;
  final String? plateNumber;
  final double? fee;
  final String? trackingUrl;

  bool get hasDetails =>
      (driverName != null && driverName!.trim().isNotEmpty) ||
      (driverPhone != null && driverPhone!.trim().isNotEmpty) ||
      (plateNumber != null && plateNumber!.trim().isNotEmpty) ||
      fee != null ||
      (trackingUrl != null && trackingUrl!.trim().isNotEmpty);

  @override
  Widget build(BuildContext context) {
    if (!hasDetails) return const SizedBox.shrink();
    final s = WingerStrings.of(context);
    final muted = TextStyle(color: WingerColors.muted);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (driverName != null && driverName!.trim().isNotEmpty)
          Text('${s.t('driverName')}: $driverName', style: muted),
        if (driverPhone != null && driverPhone!.trim().isNotEmpty)
          TextButton(
            style: TextButton.styleFrom(
              padding: EdgeInsets.zero,
              minimumSize: const Size(0, 32),
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              alignment: Alignment.centerLeft,
            ),
            onPressed: () => _open(
              context,
              Uri(
                scheme: 'tel',
                path: driverPhone!.replaceAll(RegExp(r'\s'), ''),
              ),
            ),
            child: Text('${s.t('driverPhone')}: $driverPhone'),
          ),
        if (plateNumber != null && plateNumber!.trim().isNotEmpty)
          Text('${s.t('plateNumber')}: $plateNumber', style: muted),
        if (fee != null)
          Text(
            '${s.t('courierFee')}: \$${fee!.toStringAsFixed(2)}',
            style: muted,
          ),
        if (trackingUrl != null && trackingUrl!.trim().isNotEmpty)
          TextButton(
            style: TextButton.styleFrom(
              padding: EdgeInsets.zero,
              minimumSize: const Size(0, 32),
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              alignment: Alignment.centerLeft,
            ),
            onPressed: () {
              final uri = Uri.tryParse(trackingUrl!);
              if (uri == null) return;
              _open(context, uri);
            },
            child: Text(s.t('openTracking')),
          ),
      ],
    );
  }

  Future<void> _open(BuildContext context, Uri uri) async {
    final opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (!opened && context.mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(uri.toString())));
    }
  }
}
