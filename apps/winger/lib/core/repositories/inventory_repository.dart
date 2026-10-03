import '../api/api_client.dart';
import '../offline/offline_database.dart';
import '../offline/sync_engine.dart';

class InventoryRepository {
  InventoryRepository({
    required this.db,
    required this.syncEngine,
    required this.api,
  });

  final OfflineDatabase db;
  final SyncEngine syncEngine;
  final ApiClient api;

  Future<List<({String productId, String name, String supplierId, int quantity})>>
      listForSupplier(String supplierId, {bool refreshFromServer = true}) async {
    if (refreshFromServer) {
      await pullServerStock(supplierId: supplierId);
    }
    return db.inventoryForSupplier(supplierId);
  }

  /// Flush offline receives, then align local stock with Postgres.
  Future<void> pullServerStock({String? supplierId}) async {
    await syncEngine.flush();
    try {
      final remote = await api.fetchProducts();
      if (remote.isEmpty) return;
      final filtered = supplierId == null
          ? remote
          : remote.where((p) => p.supplierId == supplierId).toList();
      if (filtered.isEmpty) return;

      await db.upsertProducts(filtered);
      for (final product in filtered) {
        await db.upsertInventory(
          productId: product.id,
          supplierId: product.supplierId,
          quantity: product.stock,
        );
        await db.updateCachedStock(product.id, product.stock);
      }
    } catch (_) {
      // Keep local cache when offline / API errors.
    }
  }

  /// Offline-safe inventory receive as a **delta** (never absolute overwrite on sync).
  Future<int> receiveStock({
    required String productId,
    required String supplierId,
    required int quantity,
    String? userId,
  }) async {
    if (quantity <= 0) {
      return await db.inventoryQty(productId) ?? 0;
    }

    final current = await db.inventoryQty(productId) ?? 0;
    final next = current + quantity;

    await db.upsertInventory(
      productId: productId,
      supplierId: supplierId,
      quantity: next,
    );
    await db.updateCachedStock(productId, next);

    await syncEngine.enqueue(
      operation: SyncOperation.inventoryReceive,
      userId: userId,
      businessId: supplierId,
      payload: {
        'productId': productId,
        'supplierId': supplierId,
        'delta': quantity,
        'localQuantityAfter': next,
      },
    );

    return next;
  }
}
