import 'package:sqlite3/common.dart';
import 'package:sqlite3/wasm.dart';

Future<CommonDatabase> openPlatformSqliteDatabase() async {
  final sqlite = await WasmSqlite3.loadFromUrl(Uri.parse('sqlite3.wasm'));
  sqlite.registerVirtualFileSystem(InMemoryFileSystem(), makeDefault: true);
  return sqlite.openInMemory();
}
