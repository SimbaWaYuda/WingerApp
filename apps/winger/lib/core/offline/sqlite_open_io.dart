import 'package:sqlite3/common.dart';
import 'package:sqlite3/sqlite3.dart';

import 'db_path.dart';
import 'sqlite_init.dart';

Future<CommonDatabase> openPlatformSqliteDatabase() async {
  await initSqlite();
  final path = await resolveSqlitePath();
  if (path == ':memory:') return sqlite3.openInMemory();
  return sqlite3.open(path);
}
