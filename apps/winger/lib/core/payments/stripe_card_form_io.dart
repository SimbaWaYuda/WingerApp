import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';

import 'stripe_card_handle.dart';

bool get usesHostedStripeCard => Platform.isWindows;

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
  InAppWebViewController? _controller;
  Completer<String>? _pending;

  @override
  void initState() {
    super.initState();
    if (!Platform.isWindows) return;
    widget.handle.attach(_createPaymentMethod);
  }

  @override
  void dispose() {
    widget.handle.detach();
    final pending = _pending;
    if (pending != null && !pending.isCompleted) {
      pending.completeError(Exception('Card form closed'));
    }
    super.dispose();
  }

  Future<String> _createPaymentMethod() async {
    final controller = _controller;
    if (controller == null) {
      throw Exception('Card form is not ready');
    }
    final pending = _pending;
    if (pending != null && !pending.isCompleted) {
      throw Exception('Card form is busy');
    }
    final completer = Completer<String>();
    _pending = completer;
    await controller.evaluateJavascript(
      source: 'window.wingerCreatePaymentMethod && window.wingerCreatePaymentMethod()',
    );
    return completer.future.timeout(
      const Duration(seconds: 20),
      onTimeout: () => throw Exception('Card could not be saved'),
    );
  }

  void _onPayload(Object? raw) {
    final pending = _pending;
    if (pending == null || pending.isCompleted) return;
    try {
      final decoded = raw is String ? jsonDecode(raw) : raw;
      final id = paymentMethodIdFromCardMessage(decoded);
      if (id == null) return;
      pending.complete(id);
    } catch (error) {
      pending.completeError(error);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!Platform.isWindows) return const SizedBox.shrink();
    return ColoredBox(
      color: Colors.white,
      child: InAppWebView(
        initialUrlRequest: URLRequest(url: WebUri(widget.frameUrl)),
        initialSettings: InAppWebViewSettings(javaScriptEnabled: true),
        onWebViewCreated: (controller) {
          _controller = controller;
          controller.addJavaScriptHandler(
            handlerName: 'WingerCard',
            callback: (args) {
              if (args.isEmpty) return null;
              _onPayload(args.first);
              return null;
            },
          );
        },
      ),
    );
  }
}
