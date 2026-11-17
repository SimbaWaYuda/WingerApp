import 'package:flutter/material.dart';

import 'winger_colors.dart';
import 'winger_tokens.dart';

/// P1 typography foundation — Fraunces headings, Source Sans 3 UI/body.
///
/// [WingerTheme.light] applies the compact (mobile) scale by default.
/// Use [textThemeForWidth] when a later stage needs web/Windows sizes.
abstract final class WingerTypography {
  static const String headingFamily = 'Fraunces';
  static const String bodyFamily = 'Source Sans 3';

  /// Fallbacks for missing glyphs (e.g. rare Swahili/Latin extended).
  static const List<String> fontFamilyFallback = [
    bodyFamily,
    'Segoe UI',
    'Roboto',
    'sans-serif',
  ];

  static const List<String> headingFallback = [
    headingFamily,
    bodyFamily,
    'Segoe UI',
    'Georgia',
    'serif',
  ];

  /// Compact/mobile scale used by [WingerTheme.light].
  static TextTheme get mobile => _build(
        display: 34,
        pageTitle: 24,
        sectionTitle: 19,
        body: 15.5,
        caption: 12.5,
        button: 14.5,
      );

  /// Expanded+ scale for web and Windows.
  static TextTheme get desktop => _build(
        display: 44,
        pageTitle: 30,
        sectionTitle: 21,
        body: 15.5,
        caption: 12.5,
        button: 14.5,
      );

  static TextTheme textThemeForWidth(double width) {
    final bp = WingerBreakpoints.of(width);
    return bp.index >= WingerBreakpoint.expanded.index ? desktop : mobile;
  }

  /// Named KPI style (not a Material role) for dashboard values.
  static TextStyle kpiValue({required bool desktop}) {
    return TextStyle(
      fontFamily: bodyFamily,
      fontFamilyFallback: fontFamilyFallback,
      fontSize: desktop ? 30 : 23,
      fontWeight: FontWeight.w700,
      height: 1.2,
      letterSpacing: -0.2,
      color: WingerColors.inkStrong,
    );
  }

  static TextTheme _build({
    required double display,
    required double pageTitle,
    required double sectionTitle,
    required double body,
    required double caption,
    required double button,
  }) {
    TextStyle heading({
      required double size,
      required FontWeight weight,
      double height = 1.2,
      double letterSpacing = -0.3,
    }) {
      return TextStyle(
        fontFamily: headingFamily,
        fontFamilyFallback: headingFallback,
        fontSize: size,
        fontWeight: weight,
        height: height,
        letterSpacing: letterSpacing,
        color: WingerColors.inkStrong,
      );
    }

    TextStyle ui({
      required double size,
      required FontWeight weight,
      double height = 1.45,
      double letterSpacing = 0,
      Color? color,
    }) {
      return TextStyle(
        fontFamily: bodyFamily,
        fontFamilyFallback: fontFamilyFallback,
        fontSize: size,
        fontWeight: weight,
        height: height,
        letterSpacing: letterSpacing,
        color: color ?? WingerColors.inkDefault,
      );
    }

    return TextTheme(
      displayLarge: heading(size: display, weight: FontWeight.w700, letterSpacing: -0.5),
      displayMedium: heading(
        size: display - 4,
        weight: FontWeight.w700,
        letterSpacing: -0.4,
      ),
      displaySmall: heading(size: pageTitle + 2, weight: FontWeight.w600),
      headlineLarge: heading(size: pageTitle, weight: FontWeight.w600),
      headlineMedium: heading(size: pageTitle, weight: FontWeight.w600),
      headlineSmall: heading(size: sectionTitle + 1, weight: FontWeight.w600),
      titleLarge: heading(size: sectionTitle, weight: FontWeight.w600, letterSpacing: -0.2),
      titleMedium: ui(size: sectionTitle - 1, weight: FontWeight.w600, height: 1.35),
      titleSmall: ui(size: body, weight: FontWeight.w600, height: 1.35),
      bodyLarge: ui(size: body + 0.5, weight: FontWeight.w400),
      bodyMedium: ui(size: body, weight: FontWeight.w400),
      bodySmall: ui(
        size: caption,
        weight: FontWeight.w400,
        color: WingerColors.inkMuted,
      ),
      labelLarge: ui(size: button, weight: FontWeight.w600, height: 1.25),
      labelMedium: ui(
        size: caption + 0.5,
        weight: FontWeight.w600,
        height: 1.25,
        color: WingerColors.inkMuted,
      ),
      labelSmall: ui(
        size: caption,
        weight: FontWeight.w500,
        height: 1.25,
        color: WingerColors.inkMuted,
      ),
    ).apply(
      bodyColor: WingerColors.inkDefault,
      displayColor: WingerColors.inkStrong,
    );
  }
}
