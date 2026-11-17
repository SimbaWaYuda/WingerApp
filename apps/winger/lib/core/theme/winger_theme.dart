import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'winger_colors.dart';
import 'winger_tokens.dart';
import 'winger_typography.dart';

/// Light Material 3 theme built on P0 tokens and P1 typography.
///
/// Dark theme is deferred. Component restyles (de-pill buttons, card shadows)
/// belong in later stages.
abstract final class WingerTheme {
  static ThemeData light() {
    final textTheme = WingerTypography.mobile;

    const colorScheme = ColorScheme.light(
      primary: WingerColors.brandPrimary,
      onPrimary: WingerColors.bgSurface,
      primaryContainer: WingerColors.brandMuted,
      onPrimaryContainer: WingerColors.inkStrong,
      secondary: WingerColors.brandSoft,
      onSecondary: WingerColors.inkStrong,
      secondaryContainer: WingerColors.brandMuted,
      onSecondaryContainer: WingerColors.inkDefault,
      surface: WingerColors.bgSurface,
      onSurface: WingerColors.inkDefault,
      onSurfaceVariant: WingerColors.inkMuted,
      surfaceContainerHighest: WingerColors.brandMuted,
      error: WingerColors.dangerInk,
      onError: WingerColors.bgSurface,
      errorContainer: WingerColors.danger,
      onErrorContainer: WingerColors.dangerInk,
      outline: WingerColors.borderDefault,
      outlineVariant: WingerColors.borderSubtle,
      shadow: WingerColors.inkStrong,
      scrim: WingerColors.inkStrong,
    );

    final base = ThemeData(
      useMaterial3: true,
      brightness: Brightness.light,
      fontFamily: WingerTypography.bodyFamily,
      scaffoldBackgroundColor: WingerColors.bgApp,
      colorScheme: colorScheme,
      focusColor: WingerColors.focusRing.withValues(alpha: 0.18),
      hoverColor: WingerColors.brandPrimaryHover.withValues(alpha: 0.06),
      splashColor: WingerColors.brandPrimary.withValues(alpha: 0.12),
      highlightColor: WingerColors.brandPrimary.withValues(alpha: 0.08),
      textTheme: textTheme,
      primaryTextTheme: textTheme,
    );

    return base.copyWith(
      appBarTheme: AppBarTheme(
        backgroundColor: WingerColors.bgElevated,
        foregroundColor: WingerColors.inkStrong,
        elevation: WingerElevation.level0,
        scrolledUnderElevation: WingerElevation.materialLevel1,
        centerTitle: false,
        titleTextStyle: textTheme.titleLarge?.copyWith(
          color: WingerColors.inkStrong,
        ),
        systemOverlayStyle: SystemUiOverlayStyle.dark.copyWith(
          statusBarColor: Colors.transparent,
        ),
      ),
      cardTheme: CardThemeData(
        color: WingerColors.bgSurface,
        elevation: WingerElevation.level0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(WingerRadius.card),
          // Borders retained until the card restyle stage prefers level-1 shadow.
          side: const BorderSide(color: WingerColors.borderDefault),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: WingerColors.bgSurface,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: WingerSpacing.s16,
          vertical: 14,
        ),
        border: OutlineInputBorder(
          borderRadius: WingerRadius.controlAll,
          borderSide: const BorderSide(color: WingerColors.borderDefault),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: WingerRadius.controlAll,
          borderSide: const BorderSide(color: WingerColors.borderDefault),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: WingerRadius.controlAll,
          borderSide: const BorderSide(
            color: WingerColors.focusRing,
            width: 1.5,
          ),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: WingerColors.brandPrimary,
          foregroundColor: WingerColors.bgSurface,
          // Finite width — Size.fromHeight uses infinity and breaks buttons in Rows.
          minimumSize: const Size(64, 48),
          // Pill radius retained until the component de-pill stage.
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(28)),
          textStyle: textTheme.labelLarge,
        ).copyWith(
          overlayColor: WidgetStateProperty.resolveWith((states) {
            if (states.contains(WidgetState.hovered) ||
                states.contains(WidgetState.pressed)) {
              return WingerColors.brandPrimaryHover.withValues(alpha: 0.16);
            }
            if (states.contains(WidgetState.focused)) {
              return WingerColors.focusRing.withValues(alpha: 0.12);
            }
            return null;
          }),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: WingerColors.brandPrimary,
          minimumSize: const Size(64, 48),
          side: const BorderSide(color: WingerColors.brandPrimary),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(28)),
          textStyle: textTheme.labelLarge,
        ),
      ),
      chipTheme: ChipThemeData(
        backgroundColor: WingerColors.brandMuted,
        selectedColor: WingerColors.brandPrimary,
        labelStyle: textTheme.labelMedium,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        side: BorderSide.none,
      ),
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: WingerColors.bgElevated,
        indicatorColor: WingerColors.brandMuted,
        labelTextStyle: WidgetStatePropertyAll(
          textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w600),
        ),
      ),
      dividerTheme: const DividerThemeData(
        color: WingerColors.borderSubtle,
        space: 1,
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: WingerColors.bgElevated,
        elevation: WingerElevation.materialLevel3,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(WingerRadius.sheet),
        ),
        titleTextStyle: textTheme.titleLarge,
        contentTextStyle: textTheme.bodyMedium,
      ),
      bottomSheetTheme: const BottomSheetThemeData(
        backgroundColor: WingerColors.bgElevated,
        elevation: WingerElevation.materialLevel2,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(
            top: Radius.circular(WingerRadius.sheet),
          ),
        ),
      ),
    );
  }
}
