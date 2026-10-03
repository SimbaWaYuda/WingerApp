import 'package:flutter/material.dart';

import 'winger_colors.dart';

abstract final class WingerTheme {
  static ThemeData light() {
    const textTheme = TextTheme(
      displayLarge: TextStyle(fontWeight: FontWeight.w800, letterSpacing: -0.5),
      displayMedium: TextStyle(fontWeight: FontWeight.w800, letterSpacing: -0.4),
      headlineMedium: TextStyle(fontWeight: FontWeight.w800, letterSpacing: -0.3),
      headlineSmall: TextStyle(fontWeight: FontWeight.w800),
      titleLarge: TextStyle(fontWeight: FontWeight.w700),
      titleMedium: TextStyle(fontWeight: FontWeight.w700),
      bodyLarge: TextStyle(height: 1.4),
      bodyMedium: TextStyle(height: 1.4),
      labelLarge: TextStyle(fontWeight: FontWeight.w700),
    );

    final base = ThemeData(
      useMaterial3: true,
      brightness: Brightness.light,
      scaffoldBackgroundColor: WingerColors.surface,
      colorScheme: const ColorScheme.light(
        primary: WingerColors.brand,
        onPrimary: WingerColors.white,
        secondary: WingerColors.brandSoft,
        onSecondary: WingerColors.dark,
        surface: WingerColors.white,
        onSurface: WingerColors.ink,
        error: WingerColors.dangerInk,
      ),
      textTheme: textTheme.apply(
        bodyColor: WingerColors.ink,
        displayColor: WingerColors.dark,
      ),
    );

    return base.copyWith(
      appBarTheme: AppBarTheme(
        backgroundColor: WingerColors.white,
        foregroundColor: WingerColors.dark,
        elevation: 0,
        centerTitle: false,
        titleTextStyle: textTheme.titleLarge?.copyWith(color: WingerColors.dark),
      ),
      cardTheme: CardThemeData(
        color: WingerColors.white,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: const BorderSide(color: WingerColors.border),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: WingerColors.white,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: WingerColors.border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: WingerColors.border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: WingerColors.brand, width: 1.5),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: WingerColors.brand,
          foregroundColor: WingerColors.white,
          // Finite width — Size.fromHeight uses infinity and breaks buttons in Rows.
          minimumSize: const Size(64, 48),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(28)),
          textStyle: textTheme.labelLarge,
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: WingerColors.brand,
          minimumSize: const Size(64, 48),
          side: const BorderSide(color: WingerColors.brand),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(28)),
        ),
      ),
      chipTheme: ChipThemeData(
        backgroundColor: WingerColors.brandMuted,
        selectedColor: WingerColors.brand,
        labelStyle: textTheme.labelMedium,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        side: BorderSide.none,
      ),
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: WingerColors.white,
        indicatorColor: WingerColors.brandMuted,
        labelTextStyle: WidgetStatePropertyAll(
          textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w600),
        ),
      ),
      dividerTheme: const DividerThemeData(color: WingerColors.border, space: 1),
    );
  }
}
