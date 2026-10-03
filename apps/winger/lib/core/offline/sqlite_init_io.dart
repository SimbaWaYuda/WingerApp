import 'package:sqlite3_flutter_libs/sqlite3_flutter_libs.dart';

Future<void> initSqlite() async {
  await applyWorkaroundToOpenSqlite3OnOldAndroidVersions();
}
