import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:winger/core/theme/winger_theme.dart';
import 'package:winger/core/theme/winger_typography.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('WingerTypography families', () {
    test('heading and body families are registered names', () {
      expect(WingerTypography.headingFamily, 'Fraunces');
      expect(WingerTypography.bodyFamily, 'Source Sans 3');
      expect(WingerTypography.fontFamilyFallback, contains('Source Sans 3'));
    });
  });

  group('WingerTypography scales', () {
    test('mobile sizes sit in approved ranges', () {
      final t = WingerTypography.mobile;
      expect(t.displayLarge!.fontSize!, inInclusiveRange(32, 36));
      expect(t.headlineMedium!.fontSize!, inInclusiveRange(24, 24));
      expect(t.titleLarge!.fontSize!, inInclusiveRange(18, 20));
      expect(t.bodyMedium!.fontSize!, inInclusiveRange(15, 16));
      expect(t.labelSmall!.fontSize!, inInclusiveRange(12, 13));
      expect(t.labelLarge!.fontSize!, inInclusiveRange(14, 15));
    });

    test('desktop sizes sit in approved ranges', () {
      final t = WingerTypography.desktop;
      expect(t.displayLarge!.fontSize!, inInclusiveRange(40, 48));
      expect(t.headlineMedium!.fontSize!, inInclusiveRange(28, 32));
      expect(t.titleLarge!.fontSize!, inInclusiveRange(20, 22));
      expect(t.bodyMedium!.fontSize!, inInclusiveRange(15, 16));
      expect(WingerTypography.kpiValue(desktop: false).fontSize!,
          inInclusiveRange(22, 24));
      expect(WingerTypography.kpiValue(desktop: true).fontSize!,
          inInclusiveRange(28, 32));
    });

    test('heading styles use Fraunces; body/UI use Source Sans 3', () {
      final t = WingerTypography.mobile;
      expect(t.displayLarge!.fontFamily, WingerTypography.headingFamily);
      expect(t.headlineMedium!.fontFamily, WingerTypography.headingFamily);
      expect(t.titleLarge!.fontFamily, WingerTypography.headingFamily);
      expect(t.bodyMedium!.fontFamily, WingerTypography.bodyFamily);
      expect(t.labelLarge!.fontFamily, WingerTypography.bodyFamily);
      expect(t.displayLarge!.fontWeight, FontWeight.w700);
      expect(t.bodyMedium!.fontWeight, FontWeight.w400);
      expect(t.labelLarge!.fontWeight, FontWeight.w600);
    });

    test('textThemeForWidth switches at expanded breakpoint', () {
      expect(
        WingerTypography.textThemeForWidth(899).displayLarge!.fontSize,
        WingerTypography.mobile.displayLarge!.fontSize,
      );
      expect(
        WingerTypography.textThemeForWidth(900).displayLarge!.fontSize,
        WingerTypography.desktop.displayLarge!.fontSize,
      );
    });
  });

  group('WingerTheme typography integration', () {
    test('light theme uses Source Sans 3 body and Fraunces display', () {
      final theme = WingerTheme.light();
      expect(
        theme.textTheme.displayLarge?.fontFamily,
        WingerTypography.headingFamily,
      );
      expect(
        theme.textTheme.bodyMedium?.fontFamily,
        WingerTypography.bodyFamily,
      );
      expect(
        theme.textTheme.labelLarge?.fontFamily,
        WingerTypography.bodyFamily,
      );
      expect(theme.textTheme.labelLarge?.fontWeight, FontWeight.w600);
    });

    testWidgets('Material text theme still resolves for existing widgets',
        (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: WingerTheme.light(),
          home: Builder(
            builder: (context) {
              final theme = Theme.of(context);
              return Scaffold(
                appBar: AppBar(title: Text('Orders', style: theme.textTheme.titleLarge)),
                body: Column(
                  children: [
                    Text('Hello', style: theme.textTheme.bodyMedium),
                    Text('KPI', style: WingerTypography.kpiValue(desktop: false)),
                    FilledButton(onPressed: () {}, child: const Text('Continue')),
                  ],
                ),
              );
            },
          ),
        ),
      );
      expect(find.text('Orders'), findsOneWidget);
      expect(find.text('Hello'), findsOneWidget);
      expect(find.text('Continue'), findsOneWidget);
    });
  });
}
