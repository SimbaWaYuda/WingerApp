import 'package:flutter_test/flutter_test.dart';
import 'package:winger/app/winger_app.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('Winger login screen renders', (tester) async {
    await tester.pumpWidget(const WingerApp());
    await tester.pump();
    expect(find.textContaining('Winger'), findsWidgets);
  });
}
