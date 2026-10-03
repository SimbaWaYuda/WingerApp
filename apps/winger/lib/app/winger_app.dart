import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../core/analytics/analytics.dart';
import '../core/api/api_client.dart';
import '../core/l10n/winger_strings.dart';
import '../core/offline/offline_database.dart';
import '../core/offline/sync_engine.dart';
import '../core/repositories/cart_repository.dart';
import '../core/repositories/catalog_repository.dart';
import '../core/repositories/inventory_repository.dart';
import '../core/state/app_session.dart';
import '../core/theme/winger_theme.dart';
import 'router.dart';

class WingerApp extends StatefulWidget {
  const WingerApp({super.key});

  @override
  State<WingerApp> createState() => _WingerAppState();
}

class _WingerAppState extends State<WingerApp> {
  late final AppSession _session;
  late final OfflineDatabase _db;
  late final ApiClient _api;
  late final SyncEngine _syncEngine;
  late final CatalogRepository _catalog;
  late final CartRepository _cartRepository;
  late final InventoryRepository _inventory;
  late final Analytics _analytics;
  late final GoRouter _router;
  Timer? _syncTimer;
  bool _ready = false;
  Object? _bootError;

  @override
  void initState() {
    super.initState();
    _session = AppSession();
    _db = OfflineDatabase();
    _api = ApiClient(_session);
    _syncEngine = SyncEngine(db: _db, session: _session);
    _catalog = CatalogRepository(db: _db, api: _api, syncEngine: _syncEngine);
    _cartRepository = CartRepository(db: _db, syncEngine: _syncEngine);
    _inventory = InventoryRepository(
      db: _db,
      syncEngine: _syncEngine,
      api: _api,
    );
    _analytics = Analytics(_api);
    _session.attachCartRepository(_cartRepository);
    _session.attachApi(_api);
    _router = createRouter(_session);
    _bootstrap();
    _syncTimer = Timer.periodic(const Duration(seconds: 12), (_) {
      if (_ready) unawaited(_syncEngine.flush());
    });
  }

  Future<void> _bootstrap() async {
    try {
      await _db.open();
      await _catalog.seedIfEmpty();
      await _session.load();
      await _syncEngine.flush();
      if (mounted) setState(() => _ready = true);
    } catch (error) {
      if (mounted) setState(() => _bootError = error);
    }
  }

  @override
  void dispose() {
    _syncTimer?.cancel();
    unawaited(_db.close());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_bootError != null) {
      return MaterialApp(
        home: Scaffold(
          body: Center(child: Text('Failed to open local DB:\n$_bootError')),
        ),
      );
    }
    if (!_ready) {
      return const MaterialApp(
        home: Scaffold(body: Center(child: CircularProgressIndicator())),
      );
    }

    return MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: _session),
        Provider.value(value: _api),
        Provider.value(value: _db),
        Provider.value(value: _syncEngine),
        Provider.value(value: _catalog),
        Provider.value(value: _cartRepository),
        Provider.value(value: _inventory),
        Provider.value(value: _analytics),
      ],
      child: AnimatedBuilder(
        animation: _session,
        builder: (context, _) {
          return MaterialApp.router(
            title: 'Winger',
            debugShowCheckedModeBanner: false,
            theme: WingerTheme.light(),
            locale: Locale(_session.localeCode.code),
            supportedLocales: WingerStrings.supported,
            localizationsDelegates: const [
              WingerStringsDelegate(),
              GlobalMaterialLocalizations.delegate,
              GlobalWidgetsLocalizations.delegate,
              GlobalCupertinoLocalizations.delegate,
            ],
            routerConfig: _router,
          );
        },
      ),
    );
  }
}
