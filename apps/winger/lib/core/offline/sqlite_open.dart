import 'package:sqlite3/common.dart';

import 'sqlite_open_stub.dart'
    if (dart.library.io) 'sqlite_open_io.dart'
    if (dart.library.js_interop) 'sqlite_open_web.dart';

Future<CommonDatabase> openSqliteDatabase() => openPlatformSqliteDatabase();
