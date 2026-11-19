import 'dart:math' as math;

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
      width: double.infinity,
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: WingerColors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: WingerColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            data.label,
            softWrap: true,
            style: const TextStyle(
              color: WingerColors.muted,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 10),
          Text(
            data.value,
            softWrap: true,
            style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: 8),
          Text(
            data.delta,
            softWrap: true,
            style: TextStyle(
              color: data.positive
                  ? WingerColors.successInk
                  : WingerColors.dangerInk,
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

/// Column count for [KpiCardGrid] (exported for layout tests).
///
/// When [balanceFourCardLayout] is true and there are exactly four children,
/// prefer 4-across or 2×2 — never a 3+1 orphan last row.
int kpiCardColumnCount({
  required double maxWidth,
  required int childCount,
  double minCardWidth = 168,
  double spacing = 12,
  bool balanceFourCardLayout = false,
}) {
  if (childCount <= 0 || maxWidth <= 0) return 1;
  final natural = math.max(
    1,
    ((maxWidth + spacing) / (minCardWidth + spacing)).floor(),
  );
  if (!balanceFourCardLayout || childCount != 4) {
    return math.min(natural, childCount);
  }
  final canFour = maxWidth + 0.001 >= (4 * minCardWidth) + (3 * spacing);
  if (canFour) return 4;
  if (natural >= 2) return 2;
  return 1;
}

/// Responsive KPI row/grid that sizes cards by available width only.
///
/// Heights follow content (no fixed [GridView] aspect ratio), so wrapped
/// labels and values cannot cause RenderFlex bottom overflow.
class KpiCardGrid extends StatelessWidget {
  const KpiCardGrid({
    super.key,
    required this.children,
    this.minCardWidth = 168,
    this.spacing = 12,
    this.balanceFourCardLayout = false,
  });

  final List<Widget> children;
  final double minCardWidth;
  final double spacing;

  /// Returns overview: avoid 3+1 so Rejected is not alone on a second row.
  final bool balanceFourCardLayout;

  @override
  Widget build(BuildContext context) {
    if (children.isEmpty) return const SizedBox.shrink();

    return LayoutBuilder(
      builder: (context, constraints) {
        final maxW = constraints.maxWidth;
        final count = kpiCardColumnCount(
          maxWidth: maxW,
          childCount: children.length,
          minCardWidth: minCardWidth,
          spacing: spacing,
          balanceFourCardLayout: balanceFourCardLayout,
        );
        final cardW = count == 1
            ? maxW
            : (maxW - spacing * (count - 1)) / count;
        return Wrap(
          spacing: spacing,
          runSpacing: spacing,
          children: [
            for (final child in children)
              SizedBox(width: cardW, child: child),
          ],
        );
      },
    );
  }
}
