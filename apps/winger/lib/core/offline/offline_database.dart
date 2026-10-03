import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:sqlite3/sqlite3.dart';

import '../models/models.dart';
import 'db_path.dart';
import 'sqlite_init.dart';

/// Local SQLite store (same schema we planned for Drift) for offline-first Winger.
class OfflineDatabase {
  OfflineDatabase();

  Database? _db;

  Database get db {
    final database = _db;
    if (database == null) {
      throw StateError('OfflineDatabase not opened. Call open() first.');
    }
    return database;
  }

  Future<void> open() async {
    if (_db != null) return;

    if (kIsWeb) {
      _db = sqlite3.openInMemory();
    } else {
      await initSqlite();
      final path = await resolveSqlitePath();
      _db = path == ':memory:' ? sqlite3.openInMemory() : sqlite3.open(path);
    }

    db.execute('PRAGMA foreign_keys = ON;');
    _migrate();
  }

  void _migrate() {
    db.execute('''
      CREATE TABLE IF NOT EXISTS cached_products (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        brand TEXT NOT NULL,
        supplier_id TEXT NOT NULL,
        supplier_name TEXT NOT NULL,
        price REAL NOT NULL,
        previous_price REAL,
        rating REAL NOT NULL DEFAULT 4.5,
        image_url TEXT NOT NULL,
        category TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT 'Standard',
        color TEXT NOT NULL DEFAULT 'Default',
        size TEXT NOT NULL DEFAULT 'Standard',
        battery TEXT NOT NULL DEFAULT '—',
        weight TEXT NOT NULL DEFAULT '—',
        description TEXT NOT NULL DEFAULT '',
        stock INTEGER NOT NULL DEFAULT 0,
        stock_status TEXT NOT NULL DEFAULT 'inStock',
        cached_at TEXT NOT NULL
      );
    ''');

    db.execute('''
      CREATE TABLE IF NOT EXISTS cart_lines (
        product_id TEXT PRIMARY KEY,
        quantity INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    ''');

    db.execute('''
      CREATE TABLE IF NOT EXISTS local_inventory (
        product_id TEXT PRIMARY KEY,
        supplier_id TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    ''');

    db.execute('''
      CREATE TABLE IF NOT EXISTS sync_events (
        event_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        user_id TEXT,
        business_id TEXT,
        created_at TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        sync_status TEXT NOT NULL DEFAULT 'PENDING',
        last_error TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0
      );
    ''');
  }

  Future<void> close() async {
    _db?.dispose();
    _db = null;
  }

  Future<int> productCount() async {
    final row = db.select('SELECT COUNT(*) AS c FROM cached_products').first;
    return row['c'] as int;
  }

  Future<void> upsertProducts(List<Product> products) async {
    final stmt = db.prepare('''
      INSERT INTO cached_products (
        id, name, brand, supplier_id, supplier_name, price, previous_price,
        rating, image_url, category, model, color, size, battery, weight,
        description, stock, stock_status, cached_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        brand=excluded.brand,
        supplier_id=excluded.supplier_id,
        supplier_name=excluded.supplier_name,
        price=excluded.price,
        previous_price=excluded.previous_price,
        rating=excluded.rating,
        image_url=excluded.image_url,
        category=excluded.category,
        model=excluded.model,
        color=excluded.color,
        size=excluded.size,
        battery=excluded.battery,
        weight=excluded.weight,
        description=excluded.description,
        stock=excluded.stock,
        stock_status=excluded.stock_status,
        cached_at=excluded.cached_at
    ''');
    final now = DateTime.now().toIso8601String();
    try {
      for (final product in products) {
        stmt.execute([
          product.id,
          product.name,
          product.brand,
          product.supplierId,
          product.supplierName,
          product.price,
          product.previousPrice,
          product.rating,
          product.imageUrl,
          product.category,
          product.model,
          product.color,
          product.size,
          product.battery,
          product.weight,
          product.description,
          product.stock,
          product.stockStatus.name,
          now,
        ]);
      }
    } finally {
      stmt.dispose();
    }
  }

  Future<List<Product>> getProducts({String query = ''}) async {
    final rows = db.select('SELECT * FROM cached_products ORDER BY name ASC');
    var products = rows.map(_productFromRow).toList();
    final q = query.trim().toLowerCase();
    if (q.isEmpty) return products;
    return products
        .where(
          (p) =>
              p.name.toLowerCase().contains(q) ||
              p.brand.toLowerCase().contains(q) ||
              p.supplierName.toLowerCase().contains(q) ||
              p.category.toLowerCase().contains(q),
        )
        .toList();
  }

  Future<Product?> getProduct(String id) async {
    final rows = db.select('SELECT * FROM cached_products WHERE id = ?', [id]);
    if (rows.isEmpty) return null;
    return _productFromRow(rows.first);
  }

  Product _productFromRow(Row row) {
    return Product(
      id: row['id'] as String,
      name: row['name'] as String,
      brand: row['brand'] as String,
      supplierId: row['supplier_id'] as String,
      supplierName: row['supplier_name'] as String,
      price: (row['price'] as num).toDouble(),
      previousPrice: (row['previous_price'] as num?)?.toDouble(),
      rating: (row['rating'] as num).toDouble(),
      imageUrl: row['image_url'] as String,
      category: row['category'] as String,
      model: row['model'] as String,
      color: row['color'] as String,
      size: row['size'] as String,
      battery: row['battery'] as String,
      weight: row['weight'] as String,
      description: row['description'] as String,
      stock: row['stock'] as int,
      stockStatus: switch (row['stock_status'] as String) {
        'lowStock' => StockStatus.lowStock,
        'outOfStock' => StockStatus.outOfStock,
        _ => StockStatus.inStock,
      },
    );
  }

  Future<List<CartItem>> loadCart() async {
    final lines = db.select('SELECT * FROM cart_lines');
    final items = <CartItem>[];
    for (final line in lines) {
      final product = await getProduct(line['product_id'] as String);
      if (product == null) continue;
      items.add(CartItem(product: product, quantity: line['quantity'] as int));
    }
    return items;
  }

  Future<void> upsertCartLine(String productId, int quantity) async {
    db.execute(
      '''
      INSERT INTO cart_lines (product_id, quantity, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(product_id) DO UPDATE SET
        quantity=excluded.quantity,
        updated_at=excluded.updated_at
      ''',
      [productId, quantity, DateTime.now().toIso8601String()],
    );
  }

  Future<void> removeCartLine(String productId) async {
    db.execute('DELETE FROM cart_lines WHERE product_id = ?', [productId]);
  }

  Future<List<String>> clearCart() async {
    final ids = db
        .select('SELECT product_id FROM cart_lines')
        .map((r) => r['product_id'] as String)
        .toList();
    db.execute('DELETE FROM cart_lines');
    return ids;
  }

  Future<void> upsertInventory({
    required String productId,
    required String supplierId,
    required int quantity,
  }) async {
    db.execute(
      '''
      INSERT INTO local_inventory (product_id, supplier_id, quantity, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(product_id) DO UPDATE SET
        supplier_id=excluded.supplier_id,
        quantity=excluded.quantity,
        updated_at=excluded.updated_at
      ''',
      [productId, supplierId, quantity, DateTime.now().toIso8601String()],
    );
  }

  Future<int?> inventoryQty(String productId) async {
    final rows = db.select(
      'SELECT quantity FROM local_inventory WHERE product_id = ?',
      [productId],
    );
    if (rows.isEmpty) return null;
    return rows.first['quantity'] as int;
  }

  Future<List<({String productId, String name, String supplierId, int quantity})>>
      inventoryForSupplier(String supplierId) async {
    final products = db.select(
      'SELECT * FROM cached_products WHERE supplier_id = ? ORDER BY name ASC',
      [supplierId],
    );
    final result = <({String productId, String name, String supplierId, int quantity})>[];
    for (final product in products) {
      final qty = await inventoryQty(product['id'] as String);
      result.add((
        productId: product['id'] as String,
        name: product['name'] as String,
        supplierId: product['supplier_id'] as String,
        quantity: qty ?? product['stock'] as int,
      ));
    }
    return result;
  }

  Future<void> updateCachedStock(String productId, int quantity) async {
    db.execute(
      '''
      UPDATE cached_products
      SET stock = ?, stock_status = ?
      WHERE id = ?
      ''',
      [quantity, quantity <= 5 ? 'lowStock' : 'inStock', productId],
    );
  }

  Future<void> enqueueSyncEvent({
    required String eventId,
    required String deviceId,
    String? userId,
    String? businessId,
    required String operation,
    required Map<String, dynamic> payload,
  }) async {
    db.execute(
      '''
      INSERT INTO sync_events (
        event_id, device_id, user_id, business_id, created_at,
        operation, payload_json, sync_status, attempt_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 0)
      ''',
      [
        eventId,
        deviceId,
        userId,
        businessId,
        DateTime.now().toIso8601String(),
        operation,
        jsonEncode(payload),
      ],
    );
  }

  Future<List<SyncEventRow>> pendingSyncEvents() async {
    final rows = db.select('''
      SELECT * FROM sync_events
      WHERE sync_status IN ('PENDING', 'FAILED')
      ORDER BY created_at ASC
    ''');
    return rows.map(SyncEventRow.fromRow).toList();
  }

  Future<int> pendingSyncCount() async {
    final row = db.select('''
      SELECT COUNT(*) AS c FROM sync_events
      WHERE sync_status IN ('PENDING', 'FAILED', 'CONFLICT')
    ''').first;
    return row['c'] as int;
  }

  Future<void> updateSyncEvent({
    required String eventId,
    required String status,
    String? lastError,
    int? attemptCount,
  }) async {
    db.execute(
      '''
      UPDATE sync_events
      SET sync_status = ?,
          last_error = ?,
          attempt_count = COALESCE(?, attempt_count)
      WHERE event_id = ?
      ''',
      [status, lastError, attemptCount, eventId],
    );
  }
}

class SyncEventRow {
  SyncEventRow({
    required this.eventId,
    required this.deviceId,
    required this.userId,
    required this.businessId,
    required this.createdAt,
    required this.operation,
    required this.payloadJson,
    required this.syncStatus,
    required this.lastError,
    required this.attemptCount,
  });

  final String eventId;
  final String deviceId;
  final String? userId;
  final String? businessId;
  final DateTime createdAt;
  final String operation;
  final String payloadJson;
  final String syncStatus;
  final String? lastError;
  final int attemptCount;

  factory SyncEventRow.fromRow(Row row) {
    return SyncEventRow(
      eventId: row['event_id'] as String,
      deviceId: row['device_id'] as String,
      userId: row['user_id'] as String?,
      businessId: row['business_id'] as String?,
      createdAt: DateTime.parse(row['created_at'] as String),
      operation: row['operation'] as String,
      payloadJson: row['payload_json'] as String,
      syncStatus: row['sync_status'] as String,
      lastError: row['last_error'] as String?,
      attemptCount: row['attempt_count'] as int,
    );
  }
}
