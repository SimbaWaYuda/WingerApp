import 'package:sqlite3/common.dart';

Future<CommonDatabase> openPlatformSqliteDatabase() {
  throw UnsupportedError('SQLite is not available on this platform.');
}
