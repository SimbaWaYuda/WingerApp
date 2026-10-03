import 'dart:io';

import 'package:path/path.dart' as p;

Future<String> resolveSqlitePath() async {
  Directory dir;
  if (Platform.isWindows) {
    final appData = Platform.environment['APPDATA'];
    dir = (appData != null && appData.isNotEmpty)
        ? Directory(p.join(appData, 'Winger'))
        : Directory(p.join(Directory.systemTemp.path, 'winger'));
  } else if (Platform.isLinux || Platform.isMacOS) {
    final home = Platform.environment['HOME'];
    dir = (home != null && home.isNotEmpty)
        ? Directory(p.join(home, '.winger'))
        : Directory(p.join(Directory.systemTemp.path, 'winger'));
  } else {
    dir = Directory(p.join(Directory.systemTemp.path, 'winger'));
  }

  if (!await dir.exists()) {
    await dir.create(recursive: true);
  }
  return p.join(dir.path, 'winger.sqlite');
}
