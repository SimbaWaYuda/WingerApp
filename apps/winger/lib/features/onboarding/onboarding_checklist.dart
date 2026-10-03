import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../core/analytics/analytics.dart';
import '../../core/api/api_client.dart';
import '../../core/l10n/winger_strings.dart';
import '../../core/state/app_session.dart';
import '../../core/theme/winger_colors.dart';
import 'onboarding_models.dart';

class OnboardingChecklistCard extends StatefulWidget {
  const OnboardingChecklistCard({
    super.key,
    required this.journeyRoute,
  });

  final String journeyRoute;

  @override
  State<OnboardingChecklistCard> createState() =>
      _OnboardingChecklistCardState();
}

class _OnboardingChecklistCardState extends State<OnboardingChecklistCard> {
  OnboardingProgress? _progress;
  String? _error;
  bool _loading = true;
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_started) {
      _started = true;
      _bootstrap();
    }
  }

  Future<void> _bootstrap() async {
    final session = context.read<AppSession>();
    final api = context.read<ApiClient>();
    final analytics = context.read<Analytics>();
    if (session.accessToken == null || !session.apiOnline) {
      setState(() {
        _loading = false;
        _error = null;
        _progress = null;
      });
      return;
    }
    try {
      var progress = await api.fetchOnboarding();
      if (progress.startedAt == null) {
        progress = await api.startOnboarding();
        await analytics.onboardingStarted(role: progress.role);
      }
      if (!mounted) return;
      setState(() {
        _progress = progress;
        _loading = false;
        _error = null;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = error.toString();
      });
    }
  }

  Future<void> _refresh() async {
    final api = context.read<ApiClient>();
    try {
      final progress = await api.fetchOnboarding();
      if (!mounted) return;
      setState(() => _progress = progress);
    } catch (_) {}
  }

  Future<void> _dismiss() async {
    final api = context.read<ApiClient>();
    final progress = await api.dismissOnboarding();
    if (!mounted) return;
    setState(() => _progress = progress);
  }

  Future<void> _resume() async {
    final api = context.read<ApiClient>();
    final progress = await api.resumeOnboarding();
    if (!mounted) return;
    setState(() => _progress = progress);
  }

  Future<void> _complete(OnboardingTask task) async {
    final api = context.read<ApiClient>();
    final analytics = context.read<Analytics>();
    try {
      final progress = await api.completeOnboardingTask(task.key);
      await analytics.onboardingStepCompleted(
        role: progress.role,
        taskKey: task.key,
      );
      if (progress.requiredComplete && progress.completedAt != null) {
        await analytics.onboardingCompleted(role: progress.role);
      }
      if (!mounted) return;
      setState(() => _progress = progress);
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('$error')),
      );
      await _refresh();
    }
  }

  Future<void> _skip(OnboardingTask task) async {
    final api = context.read<ApiClient>();
    try {
      final progress = await api.skipOnboardingTask(task.key);
      if (!mounted) return;
      setState(() => _progress = progress);
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('$error')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final session = context.watch<AppSession>();

    if (session.accessToken == null) {
      return const SizedBox.shrink();
    }
    if (_loading) {
      return const Padding(
        padding: EdgeInsets.only(bottom: 16),
        child: LinearProgressIndicator(minHeight: 3),
      );
    }
    if (_error != null) {
      return const SizedBox.shrink();
    }
    final progress = _progress;
    if (progress == null || progress.requiredComplete) {
      return const SizedBox.shrink();
    }

    if (progress.checklistDismissed) {
      return Padding(
        padding: const EdgeInsets.only(bottom: 16),
        child: Card(
          child: ListTile(
            leading: const Icon(Icons.checklist_rtl, color: WingerColors.brand),
            title: Text(s.t('obResumeTitle'), style: const TextStyle(fontWeight: FontWeight.w700)),
            subtitle: Text(s.t('obResumeBody')),
            trailing: TextButton(onPressed: _resume, child: Text(s.t('obResume'))),
          ),
        ),
      );
    }

    final pending = progress.tasks.where((t) => !t.completed && !t.skipped).length;

    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      s.t('obChecklistTitle'),
                      style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18),
                    ),
                  ),
                  Text('${progress.percent}%', style: const TextStyle(fontWeight: FontWeight.w700)),
                  IconButton(
                    tooltip: s.t('obSkipLater'),
                    onPressed: _dismiss,
                    icon: const Icon(Icons.close),
                  ),
                ],
              ),
              Text(
                s.t('obChecklistSubtitle').replaceAll('{n}', '$pending'),
                style: TextStyle(color: WingerColors.muted),
              ),
              const SizedBox(height: 8),
              ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: LinearProgressIndicator(
                  value: progress.percent / 100,
                  minHeight: 8,
                  backgroundColor: WingerColors.brandMuted,
                  color: WingerColors.brand,
                ),
              ),
              const SizedBox(height: 12),
              for (final task in progress.tasks.take(4))
                _TaskRow(
                  task: task,
                  onOpen: () {
                    if (task.route != null) context.go(task.route!);
                  },
                  onComplete: task.canComplete ? () => _complete(task) : null,
                  onSkip: !task.required && !task.skipped && !task.completed
                      ? () => _skip(task)
                      : null,
                ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                children: [
                  FilledButton(
                    onPressed: () => context.go(widget.journeyRoute),
                    child: Text(s.t('obContinueSetup')),
                  ),
                  TextButton(onPressed: _refresh, child: Text(s.t('obRefresh'))),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _TaskRow extends StatelessWidget {
  const _TaskRow({
    required this.task,
    required this.onOpen,
    this.onComplete,
    this.onSkip,
  });

  final OnboardingTask task;
  final VoidCallback onOpen;
  final VoidCallback? onComplete;
  final VoidCallback? onSkip;

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final icon = task.completed
        ? Icons.check_circle
        : task.skipped
            ? Icons.skip_next
            : task.verified
                ? Icons.radio_button_checked
                : Icons.radio_button_unchecked;
    final color = task.completed
        ? WingerColors.successInk
        : task.verified
            ? WingerColors.brand
            : WingerColors.muted;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Icon(icon, color: color, size: 20),
          const SizedBox(width: 8),
          Expanded(
            child: InkWell(
              onTap: onOpen,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    s.t(task.titleKey),
                    style: TextStyle(
                      fontWeight: FontWeight.w700,
                      decoration: task.completed ? TextDecoration.lineThrough : null,
                    ),
                  ),
                  Text(
                    task.required ? s.t('obRequired') : s.t('obOptional'),
                    style: TextStyle(fontSize: 12, color: WingerColors.muted),
                  ),
                ],
              ),
            ),
          ),
          if (onComplete != null)
            TextButton(onPressed: onComplete, child: Text(s.t('obMarkDone'))),
          if (onSkip != null)
            TextButton(onPressed: onSkip, child: Text(s.t('obSkip'))),
        ],
      ),
    );
  }
}
