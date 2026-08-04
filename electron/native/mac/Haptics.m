// Native macOS trackpad haptic feedback via NSHapticFeedbackManager.
//
// Force Touch / Magic Trackpad Taptic Engine — same path AppKit uses for
// alignment guides. Built into dist/Haptics.dylib; called from Electron main
// via koffi. No-op on hardware without Force Touch (OS handles that).
//
// Important: NSHapticFeedbackPerformanceTimeDefault only fires when AppKit is
// inside a mouse-tracking loop. IPC from Electron's renderer is never that
// path, so we always use PerformanceTimeNow.

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

static BOOL DebugEnabled(void) {
  return getenv("RESOSTAGE_DEBUG_HAPTICS") != NULL;
}

// Alignment ticks during drag can arrive at pointer-move rates; the OS will
// start silently dropping them (and sometimes the whole performer) if we
// spam. Coalesce to a pleasant detent cadence.
static CFAbsoluteTime LastAlignmentAt = 0;
static CFAbsoluteTime LastAnyAt = 0;

/// pattern: 0 = Generic, 1 = Alignment, 2 = LevelChange
__attribute__((visibility("default"))) void PerformHapticFeedback(int pattern) {
  void (^Block)(void) = ^{
    @autoreleasepool {
      // App must be active for Taptic Engine to fire.
      if (NSApp != nil && !NSApp.isActive)
        [NSApp activateIgnoringOtherApps:NO];

      const CFAbsoluteTime Now = CFAbsoluteTimeGetCurrent();

      NSHapticFeedbackPattern p;
      switch (pattern) {
        case 1:
          p = NSHapticFeedbackPatternAlignment;
          // ~50 Hz max for snap ticks — denser feels like a buzz.
          if (Now - LastAlignmentAt < 0.02)
            return;
          LastAlignmentAt = Now;
          break;
        case 2:
          p = NSHapticFeedbackPatternLevelChange;
          break;
        default:
          p = NSHapticFeedbackPatternGeneric;
          break;
      }

      // Global floor so Generic+Alignment spam from two sources can't stack.
      if (Now - LastAnyAt < 0.008)
        return;
      LastAnyAt = Now;

      id<NSHapticFeedbackPerformer> Performer =
          [NSHapticFeedbackManager defaultPerformer];
      if (Performer == nil) {
        if (DebugEnabled())
          fprintf(stderr, "Haptics: defaultPerformer is nil\n");
        return;
      }

      [Performer performFeedbackPattern:p
                        performanceTime:NSHapticFeedbackPerformanceTimeNow];

      if (DebugEnabled()) {
        fprintf(stderr, "Haptics: pattern=%d mainThread=%d active=%d\n", pattern,
                (int)[NSThread isMainThread], (int)NSApp.isActive);
      }
    }
  };

  if ([NSThread isMainThread])
    Block();
  else
    dispatch_async(dispatch_get_main_queue(), Block);
}
