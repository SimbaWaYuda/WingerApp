import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:winger/core/theme/winger_colors.dart';
import 'package:winger/core/theme/winger_theme.dart';
import 'package:winger/core/theme/winger_tokens.dart';

void main() {
  group('WingerColors P0 tokens', () {
    test('brand and ink values match approved foundation', () {
      expect(WingerColors.brandPrimary, const Color(0xFF1F4D43));
      expect(WingerColors.brandPrimaryHover, const Color(0xFF183D36));
      expect(WingerColors.brandSoft, const Color(0xFFA8C6BC));
      expect(WingerColors.brandMuted, const Color(0xFFE7F1ED));
      expect(WingerColors.inkStrong, const Color(0xFF1C2421));
      expect(WingerColors.inkDefault, const Color(0xFF24312D));
      expect(WingerColors.inkMuted, const Color(0xFF5F6E68));
      expect(WingerColors.borderSubtle, const Color(0xFFE3EAE6));
      expect(WingerColors.borderDefault, const Color(0xFFD7E0DC));
      expect(WingerColors.bgApp, const Color(0xFFF3F6F4));
      expect(WingerColors.bgSurface, const Color(0xFFFFFFFF));
      expect(WingerColors.bgElevated, const Color(0xFFFFFFFF));
      expect(WingerColors.focusRing, const Color(0xFF1F4D43));
    });

    test('legacy aliases remain wired to named tokens', () {
      expect(WingerColors.brand, WingerColors.brandPrimary);
      expect(WingerColors.dark, WingerColors.inkStrong);
      expect(WingerColors.ink, WingerColors.inkDefault);
      expect(WingerColors.muted, WingerColors.inkMuted);
      expect(WingerColors.border, WingerColors.borderDefault);
      expect(WingerColors.surface, WingerColors.bgApp);
      expect(WingerColors.white, WingerColors.bgSurface);
      expect(WingerColors.warning, WingerColors.attention);
      expect(WingerColors.warningInk, WingerColors.attentionInk);
    });

    test('semantic colours are retained', () {
      expect(WingerColors.success, const Color(0xFFD8F0E4));
      expect(WingerColors.successInk, const Color(0xFF146C43));
      expect(WingerColors.info, const Color(0xFFD9EAF8));
      expect(WingerColors.infoInk, const Color(0xFF1D5F8A));
      expect(WingerColors.attention, const Color(0xFFF6E8B5));
      expect(WingerColors.attentionInk, const Color(0xFF7A5B00));
      expect(WingerColors.danger, const Color(0xFFF5D0D4));
      expect(WingerColors.dangerInk, const Color(0xFF9B1C2E));
    });
  });

  group('WingerSpacing / radius / elevation / layout', () {
    test('spacing scale is 4-based', () {
      expect(
        WingerSpacing.scale,
        [4, 8, 12, 16, 20, 24, 32, 40, 48, 64],
      );
    });

    test('radius tokens cover controls cards chips images', () {
      expect(WingerRadius.control, 12);
      expect(WingerRadius.controlCompact, 10);
      expect(WingerRadius.card, 16);
      expect(WingerRadius.cardCompact, 12);
      expect(WingerRadius.sheet, 16);
      expect(WingerRadius.chip, 8);
      expect(WingerRadius.badge, 8);
      expect(WingerRadius.image, 12);
      expect(WingerRadius.imageCompact, 8);
    });

    test('elevation levels are defined', () {
      expect(WingerElevation.level0, 0);
      expect(WingerElevation.level1, isNotEmpty);
      expect(WingerElevation.level2, isNotEmpty);
      expect(WingerElevation.level3, isNotEmpty);
    });

    test('product image aspect ratio is 4:5', () {
      expect(WingerLayout.productImageAspectRatio, closeTo(0.8, 1e-9));
    });
  });

  group('WingerBreakpoints', () {
    test('exact boundary values', () {
      expect(WingerBreakpoints.of(0), WingerBreakpoint.compact);
      expect(WingerBreakpoints.of(599), WingerBreakpoint.compact);
      expect(WingerBreakpoints.of(600), WingerBreakpoint.medium);
      expect(WingerBreakpoints.of(899), WingerBreakpoint.medium);
      expect(WingerBreakpoints.of(900), WingerBreakpoint.expanded);
      expect(WingerBreakpoints.of(1199), WingerBreakpoint.expanded);
      expect(WingerBreakpoints.of(1200), WingerBreakpoint.large);
      expect(WingerBreakpoints.of(1439), WingerBreakpoint.large);
      expect(WingerBreakpoints.of(1440), WingerBreakpoint.extraLarge);
      expect(WingerBreakpoints.of(2000), WingerBreakpoint.extraLarge);
    });

    test('helper predicates match of()', () {
      expect(WingerBreakpoints.isCompact(599), isTrue);
      expect(WingerBreakpoints.isMedium(600), isTrue);
      expect(WingerBreakpoints.isExpanded(900), isTrue);
      expect(WingerBreakpoints.isLarge(1200), isTrue);
      expect(WingerBreakpoints.isExtraLarge(1440), isTrue);
      expect(WingerBreakpoints.isWideShell(899), isFalse);
      expect(WingerBreakpoints.isWideShell(900), isTrue);
    });
  });

  group('WingerTheme.light', () {
    test('constructs Material 3 light theme with approved ColorScheme', () {
      final theme = WingerTheme.light();
      expect(theme.useMaterial3, isTrue);
      expect(theme.brightness, Brightness.light);
      expect(theme.scaffoldBackgroundColor, WingerColors.bgApp);

      final scheme = theme.colorScheme;
      expect(scheme.brightness, Brightness.light);
      expect(scheme.primary, WingerColors.brandPrimary);
      expect(scheme.onPrimary, WingerColors.bgSurface);
      expect(scheme.secondary, WingerColors.brandSoft);
      expect(scheme.onSecondary, WingerColors.inkStrong);
      expect(scheme.surface, WingerColors.bgSurface);
      expect(scheme.onSurface, WingerColors.inkDefault);
      expect(scheme.onSurfaceVariant, WingerColors.inkMuted);
      expect(scheme.outline, WingerColors.borderDefault);
      expect(scheme.outlineVariant, WingerColors.borderSubtle);
      expect(scheme.error, WingerColors.dangerInk);
      expect(scheme.primaryContainer, WingerColors.brandMuted);
    });

    test('focus and divider use foundation tokens', () {
      final theme = WingerTheme.light();
      expect(theme.dividerTheme.color, WingerColors.borderSubtle);
      expect(theme.focusColor, isNotNull);
    });
  });
}
