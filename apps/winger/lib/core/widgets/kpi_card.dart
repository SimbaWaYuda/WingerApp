import 'package:flutter/material.dart';

import '../models/models.dart';
import '../theme/winger_colors.dart';

class KpiCard extends StatelessWidget {
  const KpiCard({super.key, required this.data, this.onTap});

  final KpiCardData data;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final card = Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: WingerColors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: WingerColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            data.label,
            style: const TextStyle(color: WingerColors.muted, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 10),
          Text(
            data.value,
            style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: 8),
          Text(
            data.delta,
            style: TextStyle(
              color: data.positive ? WingerColors.successInk : WingerColors.dangerInk,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
    if (onTap == null) return card;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(16),
        child: card,
      ),
    );
  }
}
