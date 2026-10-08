import 'dart:async';

import 'package:flutter/material.dart';

import '../theme/winger_colors.dart';

class ChipScrollRow extends StatefulWidget {
  const ChipScrollRow({super.key, required this.height, required this.children});

  final double height;
  final List<Widget> children;

  @override
  State<ChipScrollRow> createState() => _ChipScrollRowState();
}

class _ChipScrollRowState extends State<ChipScrollRow> {
  final _scroll = ScrollController();
  bool _canLeft = false;
  bool _canRight = false;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_sync);
    WidgetsBinding.instance.addPostFrameCallback((_) => _sync());
  }

  @override
  void didUpdateWidget(covariant ChipScrollRow oldWidget) {
    super.didUpdateWidget(oldWidget);
    WidgetsBinding.instance.addPostFrameCallback((_) => _sync());
  }

  @override
  void dispose() {
    _scroll.removeListener(_sync);
    _scroll.dispose();
    super.dispose();
  }

  void _sync() {
    if (!mounted || !_scroll.hasClients) return;
    final pos = _scroll.position;
    final left = pos.pixels > 4;
    final right = pos.maxScrollExtent > 4 && pos.pixels < pos.maxScrollExtent - 4;
    if (left != _canLeft || right != _canRight) {
      setState(() {
        _canLeft = left;
        _canRight = right;
      });
    }
  }

  Future<void> _move(double delta) async {
    if (!_scroll.hasClients) return;
    final target = (_scroll.offset + delta).clamp(0.0, _scroll.position.maxScrollExtent);
    await _scroll.animateTo(
      target,
      duration: const Duration(milliseconds: 280),
      curve: Curves.easeOutCubic,
    );
    _sync();
  }

  Widget _arrow(IconData icon, bool enabled) {
    return IconButton(
      visualDensity: VisualDensity.compact,
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints.tightFor(width: 32, height: 32),
      onPressed: enabled ? () => unawaited(_move(icon == Icons.chevron_left ? -180 : 180)) : null,
      icon: Icon(
        icon,
        size: 22,
        color: enabled ? WingerColors.brand : WingerColors.muted,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: widget.height,
      child: Row(
        children: [
          _arrow(Icons.chevron_left, _canLeft),
          Expanded(
            child: ListView.separated(
              controller: _scroll,
              scrollDirection: Axis.horizontal,
              itemCount: widget.children.length,
              separatorBuilder: (context, index) => const SizedBox(width: 8),
              itemBuilder: (context, index) => Align(
                alignment: Alignment.center,
                child: widget.children[index],
              ),
            ),
          ),
          _arrow(Icons.chevron_right, _canRight),
        ],
      ),
    );
  }
}
