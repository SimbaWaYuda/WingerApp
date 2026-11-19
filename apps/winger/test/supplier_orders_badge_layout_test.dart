import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:winger/core/models/models.dart';
import 'package:winger/core/widgets/status_badge.dart';

/// Mirrors the Supplier Orders card header Row after M2.4
/// (Expanded id + StatusBadge) inside a side-nav shell inset.
Widget _ordersHeaderHarness({
  required String orderId,
  required OrderStatus status,
}) {
  return MaterialApp(
    home: Scaffold(
      body: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const SizedBox(width: 260),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.all(20),
              children: [
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            orderId,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        StatusBadge(status: status),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    ),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  void installOverflowGuard(List<String> overflows) {
    final previous = FlutterError.onError;
    FlutterError.onError = (details) {
      final message = details.exceptionAsString();
      if (message.contains('overflowed') || message.contains('OVERFLOWING')) {
        overflows.add(message);
      } else {
        previous?.call(details);
      }
    };
    addTearDown(() => FlutterError.onError = previous);
  }

  for (final status in [OrderStatus.delivered, OrderStatus.processing]) {
    final label = switch (status) {
      OrderStatus.delivered => 'DELIVERED',
      OrderStatus.processing => 'PROCESSING',
      _ => status.name.toUpperCase(),
    };

    testWidgets(
      'Orders header @ 1000px keeps $label fully visible with long id',
      (tester) async {
        final overflows = <String>[];
        installOverflowGuard(overflows);

        final view = tester.view;
        view.physicalSize = const Size(1000, 900);
        view.devicePixelRatio = 1.0;
        addTearDown(view.resetPhysicalSize);
        addTearDown(view.resetDevicePixelRatio);

        await tester.pumpWidget(
          _ordersHeaderHarness(
            orderId: 'WG-10125-VERY-LONG-ORDER-IDENTIFIER',
            status: status,
          ),
        );
        await tester.pumpAndSettle();

        expect(overflows, isEmpty, reason: overflows.join('\n'));
        expect(find.text(label), findsOneWidget);

        final badge = tester.getRect(find.text(label));
        final card = tester.getRect(find.byType(Card));
        expect(badge.left, greaterThanOrEqualTo(card.left));
        expect(badge.right, lessThanOrEqualTo(card.right + 0.5));
        expect(badge.width, greaterThan(40));
      },
    );
  }

  testWidgets('Orders header @ 900px ellipsises long id without clipping badge', (
    tester,
  ) async {
    final overflows = <String>[];
    installOverflowGuard(overflows);

    final view = tester.view;
    view.physicalSize = const Size(900, 900);
    view.devicePixelRatio = 1.0;
    addTearDown(view.resetPhysicalSize);
    addTearDown(view.resetDevicePixelRatio);

    await tester.pumpWidget(
      _ordersHeaderHarness(
        orderId: 'WG-99999-EXTREMELY-LONG-ORDER-ID-FOR-LAYOUT',
        status: OrderStatus.delivered,
      ),
    );
    await tester.pumpAndSettle();

    expect(overflows, isEmpty, reason: overflows.join('\n'));
    expect(find.text('DELIVERED'), findsOneWidget);
  });
}
