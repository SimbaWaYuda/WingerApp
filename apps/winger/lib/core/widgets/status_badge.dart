import 'package:flutter/material.dart';

import '../models/models.dart';
import '../theme/winger_colors.dart';

class StatusBadge extends StatelessWidget {
  const StatusBadge({super.key, required this.status});

  final OrderStatus status;

  @override
  Widget build(BuildContext context) {
    final (label, bg, fg) = switch (status) {
      OrderStatus.processing => ('PROCESSING', WingerColors.attention, WingerColors.attentionInk),
      OrderStatus.readyForPickup => ('READY', WingerColors.success, WingerColors.successInk),
      OrderStatus.shipped => ('SHIPPED', WingerColors.info, WingerColors.infoInk),
      OrderStatus.delivered => ('DELIVERED', WingerColors.success, WingerColors.successInk),
      OrderStatus.cancelled => ('CANCELLED', WingerColors.danger, WingerColors.dangerInk),
      OrderStatus.returned => ('RETURN', WingerColors.danger, WingerColors.dangerInk),
      OrderStatus.partial => ('PARTIAL', WingerColors.attention, WingerColors.attentionInk),
    };

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(20),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: fg,
          fontSize: 11,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.4,
        ),
      ),
    );
  }
}
