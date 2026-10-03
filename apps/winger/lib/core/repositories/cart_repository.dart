import '../models/models.dart';
import '../offline/offline_database.dart';
import '../offline/sync_engine.dart';

class CartRepository {
  CartRepository({
    required this.db,
    required this.syncEngine,
  });

  final OfflineDatabase db;
  final SyncEngine syncEngine;

  Future<List<CartItem>> loadCart() => db.loadCart();

  Future<void> upsert(Product product, int quantity) async {
    await db.upsertProducts([product]);
    if (quantity <= 0) {
      await remove(product.id);
      return;
    }
    await db.upsertCartLine(product.id, quantity);
    await syncEngine.enqueue(
      operation: SyncOperation.cartUpsert,
      payload: {
        'productId': product.id,
        'quantity': quantity,
      },
    );
  }

  Future<void> remove(String productId) async {
    await db.removeCartLine(productId);
    await syncEngine.enqueue(
      operation: SyncOperation.cartRemove,
      payload: {'productId': productId},
    );
  }

  Future<void> clear() async {
    final ids = await db.clearCart();
    for (final productId in ids) {
      await syncEngine.enqueue(
        operation: SyncOperation.cartRemove,
        payload: {'productId': productId},
      );
    }
  }
}
