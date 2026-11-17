import 'package:flutter/material.dart';

/// Winger colour tokens (P0 modern design foundation).
///
/// Prefer the named role tokens (`brandPrimary`, `inkMuted`, `bgApp`, …).
/// Legacy short names remain as aliases so existing widgets keep compiling.
abstract final class WingerColors {
  // —— Brand ——
  static const Color brandPrimary = Color(0xFF1F4D43);
  static const Color brandPrimaryHover = Color(0xFF183D36);
  static const Color brandSoft = Color(0xFFA8C6BC);
  static const Color brandMuted = Color(0xFFE7F1ED);

  /// Alias for [brandPrimary].
  static const Color brand = brandPrimary;

  // —— Ink / text ——
  static const Color inkStrong = Color(0xFF1C2421);
  static const Color inkDefault = Color(0xFF24312D);
  static const Color inkMuted = Color(0xFF5F6E68);

  /// Alias for [inkStrong].
  static const Color dark = inkStrong;

  /// Alias for [inkDefault].
  static const Color ink = inkDefault;

  /// Alias for [inkMuted].
  static const Color muted = inkMuted;

  // —— Borders ——
  static const Color borderSubtle = Color(0xFFE3EAE6);
  static const Color borderDefault = Color(0xFFD7E0DC);

  /// Alias for [borderDefault].
  static const Color border = borderDefault;

  // —— Surfaces ——
  static const Color bgApp = Color(0xFFF3F6F4);
  static const Color bgSurface = Color(0xFFFFFFFF);
  static const Color bgElevated = Color(0xFFFFFFFF);

  /// App canvas / scaffold background (alias for [bgApp]).
  static const Color surface = bgApp;

  /// Alias for [bgSurface].
  static const Color white = bgSurface;

  // —— Focus ——
  static const Color focusRing = Color(0xFF1F4D43);

  // —— Semantic (retained) ——
  static const Color attention = Color(0xFFF6E8B5);
  static const Color attentionInk = Color(0xFF7A5B00);
  static const Color success = Color(0xFFD8F0E4);
  static const Color successInk = Color(0xFF146C43);
  static const Color info = Color(0xFFD9EAF8);
  static const Color infoInk = Color(0xFF1D5F8A);
  static const Color danger = Color(0xFFF5D0D4);
  static const Color dangerInk = Color(0xFF9B1C2E);

  /// Warning aliases (same values as attention).
  static const Color warning = attention;
  static const Color warningInk = attentionInk;
}
