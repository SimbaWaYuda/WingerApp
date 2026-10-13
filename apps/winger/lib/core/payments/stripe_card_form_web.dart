import 'dart:async';
import 'dart:js_interop';
import 'dart:ui_web' as ui_web;

import 'package:flutter/material.dart';
import 'package:web/web.dart' as web;

import 'stripe_card_handle.dart';

bool get usesHostedStripeCard => true;

class StripeCardForm extends StatefulWidget {
  const StripeCardForm({
    super.key,
    required this.handle,
    required this.frameUrl,
    required this.apiOrigin,
  });

  final StripeCardHandle handle;
  final String frameUrl;
  final String apiOrigin;

  @override
  State<StripeCardForm> createState() => _StripeCardFormState();
}

class _StripeCardFormState extends State<StripeCardForm> {
  static var _nextViewId = 0;
  late final String _viewType = 'winger-stripe-card-${_nextViewId++}';
  web.HTMLIFrameElement? _iframe;
  Completer<String>? _pending;
  late final web.EventListener _listener = _onMessage.toJS;

  @override
  void initState() {
    super.initState();
    widget.handle.attach(_createPaymentMethod);
    ui_web.platformViewRegistry.registerViewFactory(_viewType, (int viewId) {
      final iframe = web.HTMLIFrameElement()
        ..src = widget.frameUrl
        ..style.border = '0'
        ..style.width = '100%'
        ..style.height = '100%';
      iframe.setAttribute('allow', 'payment *');
      _iframe = iframe;
      return iframe;
    });
    web.window.addEventListener('message', _listener);
  }

  @override
  void dispose() {
    widget.handle.detach();
    web.window.removeEventListener('message', _listener);
    final pending = _pending;
    if (pending != null && !pending.isCompleted) {
      pending.completeError(Exception('Card form closed'));
    }
    super.dispose();
  }

  Future<String> _createPaymentMethod() {
    final iframe = _iframe;
    final target = iframe?.contentWindow;
    if (target == null) {
      throw Exception('Card form is not ready');
    }
    final pending = _pending;
    if (pending != null && !pending.isCompleted) {
      throw Exception('Card form is busy');
    }
    final completer = Completer<String>();
    _pending = completer;
    target.postMessage(
      {'type': 'winger-create-payment-method'}.jsify(),
      '*'.toJS,
    );
    return completer.future.timeout(
      const Duration(seconds: 20),
      onTimeout: () => throw Exception('Card could not be saved'),
    );
  }

  void _onMessage(web.Event event) {
    final message = event as web.MessageEvent;
    if (message.origin != widget.apiOrigin) return;
    final pending = _pending;
    if (pending == null || pending.isCompleted) return;
    try {
      final id = paymentMethodIdFromCardMessage(message.data?.dartify());
      if (id == null) return;
      pending.complete(id);
    } catch (error) {
      pending.completeError(error);
    }
  }

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: Colors.white,
      child: HtmlElementView(viewType: _viewType),
    );
  }
}
