// Native macOS menu-bar flash via NSMenuBarImpl.
//
// The system menu bar is owned by a private NSMenuBarImpl. Calling
// -highlightItemAtIndex: on it paints the same title highlight AppKit uses
// when a real keyboard equivalent fires. Cleared with -unhighlightItemIfNeeded.
//
// Built into dist/MenuFlash.dylib; called from Electron main via koffi.

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <objc/message.h>
#import <objc/runtime.h>

static NSInteger FlashGeneration = 0;

static BOOL DebugEnabled(void) {
  return getenv("RESOSTAGE_DEBUG_MENU_FLASH") != NULL;
}

static id MenuBarImpl(NSMenu *MainMenu) {
  if (MainMenu == nil)
    return nil;
  SEL Sel = sel_registerName("_menuBarImpl");
  if (![MainMenu respondsToSelector:Sel])
    return nil;
  return ((id (*)(id, SEL))objc_msgSend)(MainMenu, Sel);
}

static NSMenuItem *FindTopLevelItem(NSMenu *MainMenu, NSString *Title) {
  if (MainMenu == nil || Title.length == 0)
    return nil;

  NSMenuItem *TopItem = [MainMenu itemWithTitle:Title];
  if (TopItem != nil)
    return TopItem;

  for (NSMenuItem *Item in MainMenu.itemArray) {
    if (Item.submenu != nil && [Item.submenu.title isEqualToString:Title])
      return Item;
    if (Item.title.length > 0 &&
        [Item.title caseInsensitiveCompare:Title] == NSOrderedSame)
      return Item;
  }

  if ([Title caseInsensitiveCompare:@"ResoStage"] == NSOrderedSame ||
      [Title caseInsensitiveCompare:NSProcessInfo.processInfo.processName] ==
          NSOrderedSame) {
    return MainMenu.itemArray.firstObject;
  }
  return nil;
}

static void HighlightBarIndex(id Impl, NSInteger Index) {
  if (Impl == nil || Index < 0)
    return;

  // Prefer the "visible item" path used by keyboard menu-bar navigation —
  // that is the paint users actually see on the system menu bar.
  SEL Visible =
      sel_registerName("_highlightVisibleItemAtIndex:allowingDisabledItems:");
  if ([Impl respondsToSelector:Visible]) {
    ((void (*)(id, SEL, NSInteger, BOOL))objc_msgSend)(Impl, Visible, Index,
                                                         YES);
    return;
  }

  SEL Sel = sel_registerName("highlightItemAtIndex:");
  if ([Impl respondsToSelector:Sel])
    ((void (*)(id, SEL, NSInteger))objc_msgSend)(Impl, Sel, Index);
}

static void UnhighlightBar(id Impl) {
  if (Impl == nil)
    return;
  SEL Sel = sel_registerName("unhighlightItemIfNeeded");
  if ([Impl respondsToSelector:Sel])
    ((void (*)(id, SEL))objc_msgSend)(Impl, Sel);

  // Also clear any secondary/agent highlight.
  SEL Remove = sel_registerName("_removeAuxiliaryHighlightIfNeeded");
  if ([Impl respondsToSelector:Remove])
    ((void (*)(id, SEL))objc_msgSend)(Impl, Remove);
}

static void DoFlashTitle(NSString *Title) {
  NSMenu *MainMenu = NSApp.mainMenu;
  if (MainMenu == nil) {
    if (DebugEnabled())
      fprintf(stderr, "MenuFlash: NSApp.mainMenu is nil\n");
    return;
  }

  NSMenuItem *TopItem = FindTopLevelItem(MainMenu, Title);
  if (TopItem == nil) {
    if (DebugEnabled()) {
      fprintf(stderr, "MenuFlash: no top-level item titled '%s'\n",
              Title.UTF8String);
      fprintf(stderr, "  bar:");
      for (NSMenuItem *It in MainMenu.itemArray)
        fprintf(stderr, " '%s'", It.title.UTF8String ?: "");
      fprintf(stderr, "\n");
    }
    return;
  }
  if ([TopItem.title isEqualToString:@"Apple"])
    return;

  NSInteger Index = [MainMenu indexOfItem:TopItem];
  if (Index < 0)
    return;

  id Impl = MenuBarImpl(MainMenu);
  if (Impl == nil) {
    if (DebugEnabled())
      fprintf(stderr, "MenuFlash: _menuBarImpl is nil\n");
    return;
  }

  [NSApp activateIgnoringOtherApps:YES];

  const NSInteger Gen = ++FlashGeneration;
  HighlightBarIndex(Impl, Index);

  if (DebugEnabled()) {
    fprintf(stderr, "MenuFlash: highlightItemAtIndex:%ld title='%s' gen=%ld\n",
            (long)Index, TopItem.title.UTF8String ?: "", (long)Gen);
  }

  dispatch_after(
      dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.2 * NSEC_PER_SEC)),
      dispatch_get_main_queue(), ^{
        if (Gen != FlashGeneration)
          return;
        // Re-fetch impl — Electron may have replaced the menu.
        id StillImpl = MenuBarImpl(NSApp.mainMenu);
        UnhighlightBar(StillImpl != nil ? StillImpl : Impl);
      });
}

/// Flash the top-level menu bar title (e.g. "Transport", "Edit").
__attribute__((visibility("default"))) void FlashMenuTitle(const char *TitleUtf8) {
  if (TitleUtf8 == NULL || TitleUtf8[0] == '\0')
    return;

  NSString *Title = [[NSString alloc] initWithUTF8String:TitleUtf8];
  if (Title.length == 0)
    return;

  void (^Block)(void) = ^{
    @autoreleasepool {
      DoFlashTitle(Title);
    }
  };

  if ([NSThread isMainThread])
    Block();
  else
    dispatch_async(dispatch_get_main_queue(), Block);
}
