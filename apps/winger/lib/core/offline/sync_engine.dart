import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:uuid/uuid.dart';

import '../state/app_session.dart';
import 'offline_database.dart';

enum SyncOperation {
  inventoryReceive('INVENTORY_RECEIVE'),
  inventoryAdjust('INVENTORY_ADJUST'),
  cartUpsert('CART_UPSERT'),
  cartRemove('CART_REMOVE'),
  orderStatusUpdate('ORDER_STATUS_UPDATE');

  const SyncOperation(this.value);
  final String value;
}

class SyncEngine {
  SyncEngine({
    required this.db,
    required this.session,
    http.Client? httpClient,
  }) : _http = httpClient ?? http.Client();

  final OfflineDatabase db;
  final AppSession session;
  final http.Client _http;
  final _uuid = const Uuid();
  static const deviceId = 'winger-desktop-1';

  bool _flushing = false;

  Future<String> enqueue({
    required SyncOperation operation,
    required Map<String, dynamic> payload,
    String? userId,
    String? businessId,
  }) async {
    final eventId = _uuid.v4();
    await db.enqueueSyncEvent(
      eventId: eventId,
      deviceId: deviceId,
      userId: userId,
      businessId: businessId,
      operation: operation.value,
      payload: payload,
    );
    session.setPendingSyncCount(await db.pendingSyncCount());
    return eventId;
  }

  Future<void> refreshPendingCount() async {
    session.setPendingSyncCount(await db.pendingSyncCount());
  }

  Future<void> flush() async {
    if (_flushing) return;
    _flushing = true;
    try {
      final online = await _health();
      session.setApiOnline(online);
      if (!online) {
        await refreshPendingCount();
        return;
      }

      final pending = await db.pendingSyncEvents();
      for (final event in pending) {
        await db.updateSyncEvent(
          eventId: event.eventId,
          status: 'SYNCING',
          attemptCount: event.attemptCount + 1,
        );

        try {
          if (session.accessToken == null) {
            await db.updateSyncEvent(
              eventId: event.eventId,
              status: 'FAILED',
              lastError: 'Not authenticated',
            );
            continue;
          }

          final response = await _http
              .post(
                Uri.parse('${session.apiBaseUrl}/sync/events'),
                headers: session.authHeaders,
                body: jsonEncode({
                  'eventId': event.eventId,
                  'deviceId': event.deviceId,
                  'userId': event.userId ?? session.userId,
                  'businessId': event.businessId ?? session.supplierId,
                  'timestamp': event.createdAt.toIso8601String(),
                  'operation': event.operation,
                  'payload': jsonDecode(event.payloadJson),
                }),
              )
              .timeout(const Duration(seconds: 5));

          if (response.statusCode == 401 || response.statusCode == 403) {
            await db.updateSyncEvent(
              eventId: event.eventId,
              status: 'FAILED',
              lastError: 'HTTP ${response.statusCode} unauthorized',
            );
            continue;
          }

          if (response.statusCode >= 200 && response.statusCode < 300) {
            final body = jsonDecode(response.body) as Map<String, dynamic>;
            final status = body['status'] as String? ?? 'SUCCESS';
            if (status == 'CONFLICT') {
              await db.updateSyncEvent(
                eventId: event.eventId,
                status: 'CONFLICT',
                lastError: body['message'] as String? ?? 'Conflict',
              );
            } else {
              final productId = body['productId'] as String?;
              final productStock = body['productStock'];
              if (productId != null && productStock is num) {
                final qty = productStock.toInt();
                final payload =
                    jsonDecode(event.payloadJson) as Map<String, dynamic>;
                final supplierId =
                    payload['supplierId'] as String? ?? session.supplierId;
                if (supplierId != null) {
                  await db.upsertInventory(
                    productId: productId,
                    supplierId: supplierId,
                    quantity: qty,
                  );
                }
                await db.updateCachedStock(productId, qty);
              }
              await db.updateSyncEvent(
                eventId: event.eventId,
                status: 'SUCCESS',
                lastError: null,
              );
            }
          } else {
            await db.updateSyncEvent(
              eventId: event.eventId,
              status: 'FAILED',
              lastError: 'HTTP ${response.statusCode}',
            );
          }
        } catch (error) {
          await db.updateSyncEvent(
            eventId: event.eventId,
            status: 'FAILED',
            lastError: error.toString(),
          );
          session.setApiOnline(false);
          break;
        }
      }
      await refreshPendingCount();
    } finally {
      _flushing = false;
    }
  }

  Future<bool> _health() async {
    try {
      final response = await _http
          .get(Uri.parse('${session.apiBaseUrl}/health'))
          .timeout(const Duration(seconds: 2));
      return response.statusCode == 200;
    } catch (_) {
      return false;
    }
  }
}
