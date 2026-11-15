import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:winger/core/api/api_client.dart';
import 'package:winger/core/l10n/winger_strings.dart';
import 'package:winger/core/state/app_session.dart';
import 'package:winger/features/admin/commission_collection_panel.dart';
import 'package:winger/features/supplier/commission_account_panel.dart';

class _LipaEvidenceApi extends ApiClient {
  _LipaEvidenceApi(super.session);

  final evidence = <({String orderId, String reference})>[];
  final rejections = <({String id, String note})>[];
  List<dynamic> supplierEvidence = const [];

  @override
  Future<Map<String, dynamic>> fetchSupplierCommissionAccount() async => {};

  @override
  Future<Map<String, dynamic>> fetchSupplierReceivingAccounts() async => {};

  @override
  Future<List<dynamic>> fetchSupplierRemittances() async => const [];

  @override
  Future<List<dynamic>> fetchSupplierLipaEvidence() async => supplierEvidence;

  @override
  Future<void> submitLipaEvidence({
    required String orderId,
    required String reference,
    String? note,
  }) async {
    evidence.add((orderId: orderId, reference: reference));
  }

  @override
  Future<Map<String, dynamic>> fetchAdminCommissionAccounts() async =>
      {'suppliers': const []};

  @override
  Future<Map<String, dynamic>> fetchHeldFunds() async => {};

  @override
  Future<Map<String, dynamic>> fetchReceivingAccounts() async => {};

  @override
  Future<List<dynamic>> fetchAdminRemittances() async => const [];

  @override
  Future<List<dynamic>> fetchAdminLipaEvidence() async => [
        {
          'id': 'ev-1',
          'status': 'SUBMITTED',
          'supplierName': 'Kijani Tech',
          'orderNumber': 'WG-10127',
          'amount': 48,
          'currency': 'USD',
          'reference': 'TEST-CUST-LIPA-V2-002',
          'submittedAt': '2026-11-14T20:09:38.263Z',
          'reviewNote': null,
        },
      ];

  @override
  Future<void> rejectCustomerLipaEvidence(String id, String reviewNote) async {
    rejections.add((id: id, note: reviewNote));
  }
}

class _RebuildHost extends StatefulWidget {
  const _RebuildHost({super.key, required this.child});

  final Widget child;

  @override
  State<_RebuildHost> createState() => _RebuildHostState();
}

class _RebuildHostState extends State<_RebuildHost> {
  int generation = 0;

  void rebuild() => setState(() => generation++);

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('generation-$generation'),
        widget.child,
      ],
    );
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<({_LipaEvidenceApi api, GlobalKey<_RebuildHostState> host})> pumpPanel(
    WidgetTester tester,
    Widget panel, {
    void Function(_LipaEvidenceApi api)? prepare,
  }) async {
    final api = _LipaEvidenceApi(AppSession());
    prepare?.call(api);
    final host = GlobalKey<_RebuildHostState>();
    await tester.pumpWidget(
      Provider<ApiClient>.value(
        value: api,
        child: MaterialApp(
          locale: const Locale('en'),
          supportedLocales: WingerStrings.supported,
          localizationsDelegates: const [
            WingerStringsDelegate(),
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          home: Scaffold(
            body: SingleChildScrollView(
              child: _RebuildHost(
                key: host,
                child: panel,
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();
    return (api: api, host: host);
  }

  Future<void> tapVisible(WidgetTester tester, Finder finder) async {
    await tester.ensureVisible(finder);
    await tester.pump();
    await tester.tap(finder);
  }

  testWidgets('supplier submit sends the order id and reference on screen', (tester) async {
    final harness = await pumpPanel(tester, const SupplierCommissionAccountPanel());
    await tester.enterText(find.byKey(const ValueKey('lipa-evidence-order')), 'WG-10126');
    await tester.enterText(
      find.byKey(const ValueKey('lipa-evidence-reference')),
      'TEST-CUST-LIPA-V2-001',
    );
    await tapVisible(tester, find.widgetWithText(OutlinedButton, 'Customer Lipa evidence'));
    await tester.pump();
    await tester.pump();

    expect(harness.api.evidence, [
      (orderId: 'WG-10126', reference: 'TEST-CUST-LIPA-V2-001'),
    ]);
  });

  testWidgets('empty supplier evidence fields do not submit', (tester) async {
    final harness = await pumpPanel(tester, const SupplierCommissionAccountPanel());
    await tapVisible(tester, find.widgetWithText(OutlinedButton, 'Customer Lipa evidence'));
    await tester.pump();

    expect(harness.api.evidence, isEmpty);
    expect(find.text('Order ID is required'), findsOneWidget);

    final messenger = tester.state<ScaffoldMessengerState>(find.byType(ScaffoldMessenger));
    messenger.hideCurrentSnackBar();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    await tester.enterText(find.byKey(const ValueKey('lipa-evidence-order')), 'WG-10126');
    await tapVisible(tester, find.widgetWithText(OutlinedButton, 'Customer Lipa evidence'));
    await tester.pump();

    expect(harness.api.evidence, isEmpty);
    expect(find.text('Payment reference is required'), findsOneWidget);
  });

  testWidgets('supplier evidence history shows the rejection note', (tester) async {
    await pumpPanel(
      tester,
      const SupplierCommissionAccountPanel(),
      prepare: (api) {
        api.supplierEvidence = [
          {
            'id': 'ev-open',
            'status': 'SUBMITTED',
            'orderNumber': 'WG-10128',
            'reference': 'TEST-CUST-LIPA-V3-001',
            'submittedAt': '2026-11-14T20:41:20.660Z',
            'reviewNote': null,
          },
          {
            'id': 'ev-rejected',
            'status': 'REJECTED',
            'orderNumber': 'WG-10127',
            'reference': 'TEST-CUST-LIPA-V2-002',
            'submittedAt': '2026-11-14T20:09:38.263Z',
            'reviewNote': 'Test rejection, payment not received',
          },
        ];
      },
    );

    expect(find.textContaining('WG-10128 · Submitted'), findsOneWidget);
    expect(find.textContaining('TEST-CUST-LIPA-V3-001'), findsOneWidget);
    expect(find.textContaining('WG-10127 · Rejected'), findsOneWidget);
    expect(find.textContaining('Rejection note: Test rejection, payment not received'), findsOneWidget);
    expect(find.widgetWithText(TextButton, 'Reject'), findsNothing);
    expect(find.widgetWithText(TextButton, 'Verify payment'), findsNothing);
  });

  testWidgets('rebuilding the supplier form keeps the entered evidence', (tester) async {
    final harness = await pumpPanel(tester, const SupplierCommissionAccountPanel());
    await tester.enterText(find.byKey(const ValueKey('lipa-evidence-order')), 'WG-10127');
    await tester.enterText(
      find.byKey(const ValueKey('lipa-evidence-reference')),
      'TEST-CUST-LIPA-V2-002',
    );
    harness.host.currentState!.rebuild();
    await tester.pump();

    expect(find.text('generation-1'), findsOneWidget);
    expect(
      tester.widget<TextField>(find.byKey(const ValueKey('lipa-evidence-order'))).controller!.text,
      'WG-10127',
    );
    expect(
      tester.widget<TextField>(find.byKey(const ValueKey('lipa-evidence-reference'))).controller!.text,
      'TEST-CUST-LIPA-V2-002',
    );

    await tapVisible(tester, find.widgetWithText(OutlinedButton, 'Customer Lipa evidence'));
    await tester.pump();
    await tester.pump();

    expect(harness.api.evidence, [
      (orderId: 'WG-10127', reference: 'TEST-CUST-LIPA-V2-002'),
    ]);
  });

  testWidgets('admin reject sends the note shown in the field', (tester) async {
    final harness = await pumpPanel(tester, const AdminCommissionCollectionPanel());
    expect(find.textContaining('WG-10127'), findsOneWidget);

    await tester.enterText(
      find.byKey(const ValueKey('lipa-evidence-reject-note')),
      'Test rejection, payment not received',
    );
    await tapVisible(tester, find.widgetWithText(TextButton, 'Reject'));
    await tester.pump();
    await tester.pump();

    expect(harness.api.rejections, [
      (id: 'ev-1', note: 'Test rejection, payment not received'),
    ]);
  });

  testWidgets('an empty rejection note does not reject', (tester) async {
    final harness = await pumpPanel(tester, const AdminCommissionCollectionPanel());
    await tapVisible(tester, find.widgetWithText(TextButton, 'Reject'));
    await tester.pump();

    expect(harness.api.rejections, isEmpty);
    expect(find.text('A rejection note is required'), findsOneWidget);
  });

  testWidgets('rebuilding the admin panel keeps the rejection note', (tester) async {
    final harness = await pumpPanel(tester, const AdminCommissionCollectionPanel());
    await tester.enterText(
      find.byKey(const ValueKey('lipa-evidence-reject-note')),
      'Payment was not received',
    );
    harness.host.currentState!.rebuild();
    await tester.pump();

    expect(
      tester.widget<TextField>(find.byKey(const ValueKey('lipa-evidence-reject-note'))).controller!.text,
      'Payment was not received',
    );

    await tapVisible(tester, find.widgetWithText(TextButton, 'Reject'));
    await tester.pump();
    await tester.pump();

    expect(harness.api.rejections, [
      (id: 'ev-1', note: 'Payment was not received'),
    ]);
  });
}
