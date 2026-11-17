import 'package:flutter/material.dart';

import 'winger_colors.dart';

/// 4-based spacing scale (logical pixels).
abstract final class WingerSpacing {
  static const double s4 = 4;
  static const double s8 = 8;
  static const double s12 = 12;
  static const double s16 = 16;
  static const double s20 = 20;
  static const double s24 = 24;
  static const double s32 = 32;
  static const double s40 = 40;
  static const double s48 = 48;
  static const double s64 = 64;

  static const List<double> scale = [
    s4,
    s8,
    s12,
    s16,
    s20,
    s24,
    s32,
    s40,
    s48,
    s64,
  ];
}

/// Corner radii for controls, cards, chips and imagery.
///
/// P0 exposes tokens only — existing widgets are not mass-migrated yet.
abstract final class WingerRadius {
  static const double control = 12;
  static const double controlCompact = 10;
  static const double card = 16;
  static const double cardCompact = 12;
  static const double sheet = 16;
  static const double chip = 8;
  static const double badge = 8;
  static const double image = 12;
  static const double imageCompact = 8;

  static BorderRadius get controlAll => BorderRadius.circular(control);
  static BorderRadius get cardAll => BorderRadius.circular(card);
  static BorderRadius get chipAll => BorderRadius.circular(chip);
  static BorderRadius get imageAll => BorderRadius.circular(image);
}

/// Restrained elevation levels (prefer shadows over heavy borders).
abstract final class WingerElevation {
  static const double level0 = 0;

  /// Subtle product/surface cards.
  static const List<BoxShadow> level1 = [
    BoxShadow(
      color: Color(0x0F1C2421),
      offset: Offset(0, 1),
      blurRadius: 2,
    ),
  ];

  /// Sticky headers and popovers.
  static const List<BoxShadow> level2 = [
    BoxShadow(
      color: Color(0x141C2421),
      offset: Offset(0, 2),
      blurRadius: 8,
      spreadRadius: -1,
    ),
  ];

  /// Dialogs and modal surfaces.
  static const List<BoxShadow> level3 = [
    BoxShadow(
      color: Color(0x1A1C2421),
      offset: Offset(0, 8),
      blurRadius: 24,
      spreadRadius: -4,
    ),
  ];

  /// Material elevation doubles for themes that still use [elevation].
  static const double materialLevel1 = 1;
  static const double materialLevel2 = 3;
  static const double materialLevel3 = 6;
}

/// Named layout breakpoints (width in logical pixels).
///
/// Boundaries are inclusive on the minimum side of each named range.
enum WingerBreakpoint {
  /// Below 600.
  compact,

  /// 600–899.
  medium,

  /// 900–1199.
  expanded,

  /// 1200–1439.
  large,

  /// 1440 and above.
  extraLarge,
}

abstract final class WingerBreakpoints {
  static const double compactMax = 599;
  static const double mediumMin = 600;
  static const double mediumMax = 899;
  static const double expandedMin = 900;
  static const double expandedMax = 1199;
  static const double largeMin = 1200;
  static const double largeMax = 1439;
  static const double extraLargeMin = 1440;

  static WingerBreakpoint of(double width) {
    if (width < mediumMin) return WingerBreakpoint.compact;
    if (width < expandedMin) return WingerBreakpoint.medium;
    if (width < largeMin) return WingerBreakpoint.expanded;
    if (width < extraLargeMin) return WingerBreakpoint.large;
    return WingerBreakpoint.extraLarge;
  }

  static bool isCompact(double width) => of(width) == WingerBreakpoint.compact;
  static bool isMedium(double width) => of(width) == WingerBreakpoint.medium;
  static bool isExpanded(double width) => of(width) == WingerBreakpoint.expanded;
  static bool isLarge(double width) => of(width) == WingerBreakpoint.large;
  static bool isExtraLarge(double width) =>
      of(width) == WingerBreakpoint.extraLarge;

  /// Wide shell / side-nav threshold used by later stages (expanded and up).
  static bool isWideShell(double width) => width >= expandedMin;
}

/// Shared layout metrics approved for later product UI stages.
abstract final class WingerLayout {
  /// Product photography aspect ratio (width : height = 4 : 5).
  static const double productImageAspectRatio = 4 / 5;

  static const Color focusRingColor = WingerColors.focusRing;
}
