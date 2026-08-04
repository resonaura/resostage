// Native macOS application-menu flash (the bar next to the Apple menu —
// File / Edit / Transport / …), matching the system highlight when a real
// key equivalent fires.
//
// Strategy (in order):
//   1. Private NSMenuBarImpl highlight of the top-level title (keyboard-eq feel).
//   2. performActionForItemAtIndex: on the leaf with target/action stripped
//      so we get the AppKit flash animation WITHOUT re-running the Electron
//      click handler (action already posted via IPC).
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

  // KVC first — survives some selector renames better than respondsToSelector.
  @try {
    id ViaKvc = [MainMenu valueForKey:@"_menuBarImpl"];
    if (ViaKvc != nil)
      return ViaKvc;
  } @catch (__unused NSException *Ex) {
  }

  SEL Sel = sel_registerName("_menuBarImpl");
  if ([MainMenu respondsToSelector:Sel])
    return ((id (*)(id, SEL))objc_msgSend)(MainMenu, Sel);
  return nil;
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

  // App menu is often the process name while the model says "ResoStage".
  if ([Title caseInsensitiveCompare:@"ResoStage"] == NSOrderedSame ||
      [Title caseInsensitiveCompare:NSProcessInfo.processInfo.processName] ==
          NSOrderedSame ||
      [Title caseInsensitiveCompare:[NSRunningApplication currentApplication]
                                        .localizedName ?:
                                    @""] == NSOrderedSame) {
    return MainMenu.itemArray.firstObject;
  }
  return nil;
}

static NSMenuItem *FindLeafItem(NSMenu *SubMenu, NSString *ItemTitle) {
  if (SubMenu == nil || ItemTitle.length == 0)
    return nil;
  NSMenuItem *Exact = [SubMenu itemWithTitle:ItemTitle];
  if (Exact != nil)
    return Exact;
  for (NSMenuItem *It in SubMenu.itemArray) {
    if (It.isSeparatorItem)
      continue;
    if (It.title.length > 0 &&
        [It.title caseInsensitiveCompare:ItemTitle] == NSOrderedSame)
      return It;
    // Electron sometimes appends "\t⌘S" display of accelerators into the
    // title on older builds — match prefix.
    if (It.title.length > ItemTitle.length &&
        [It.title hasPrefix:ItemTitle])
      return It;
  }
  return nil;
}

static void HighlightBarIndex(id Impl, NSInteger Index) {
  if (Impl == nil || Index < 0)
    return;

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

  SEL Remove = sel_registerName("_removeAuxiliaryHighlightIfNeeded");
  if ([Impl respondsToSelector:Remove])
    ((void (*)(id, SEL))objc_msgSend)(Impl, Remove);
}

/// Flash a leaf item via performActionForItemAtIndex: without re-firing the
/// Electron click handler (target/action temporarily cleared).
static void FlashLeafWithoutAction(NSMenuItem *Leaf) {
  if (Leaf == nil || Leaf.menu == nil)
    return;
  NSMenu *Menu = Leaf.menu;
  NSInteger Idx = [Menu indexOfItem:Leaf];
  if (Idx < 0)
    return;

  id SavedTarget = Leaf.target;
  SEL SavedAction = Leaf.action;
  // Clearing both prevents the Electron menu controller from seeing a click
  // while AppKit still runs its highlight animation for performAction…
  Leaf.target = nil;
  Leaf.action = nil;
  @try {
    [Menu performActionForItemAtIndex:Idx];
  } @catch (__unused NSException *Ex) {
  }
  Leaf.target = SavedTarget;
  Leaf.action = SavedAction;
}

static void DoFlash(NSString *TopTitle, NSString *ItemTitle) {
  NSMenu *MainMenu = NSApp.mainMenu;
  if (MainMenu == nil) {
    if (DebugEnabled())
      fprintf(stderr, "MenuFlash: NSApp.mainMenu is nil\n");
    return;
  }

  NSMenuItem *TopItem = FindTopLevelItem(MainMenu, TopTitle);
  if (TopItem == nil) {
    if (DebugEnabled()) {
      fprintf(stderr, "MenuFlash: no top-level item titled '%s'\n",
              TopTitle.UTF8String);
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

  // Prefer key-window focus so the system menu bar paints for THIS app.
  [NSApp activateIgnoringOtherApps:YES];

  BOOL DidBarHighlight = NO;
  id Impl = MenuBarImpl(MainMenu);
  if (Impl != nil) {
    const NSInteger Gen = ++FlashGeneration;
    HighlightBarIndex(Impl, Index);
    DidBarHighlight = YES;
    if (DebugEnabled()) {
      fprintf(stderr,
              "MenuFlash: bar highlight index=%ld title='%s' gen=%ld\n",
              (long)Index, TopItem.title.UTF8String ?: "", (long)Gen);
    }
    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.18 * NSEC_PER_SEC)),
        dispatch_get_main_queue(), ^{
          if (Gen != FlashGeneration)
            return;
          id StillImpl = MenuBarImpl(NSApp.mainMenu);
          UnhighlightBar(StillImpl != nil ? StillImpl : Impl);
        });
  } else if (DebugEnabled()) {
    fprintf(stderr, "MenuFlash: _menuBarImpl unavailable — leaf fallback only\n");
  }

  // Leaf flash: real AppKit performAction animation (item highlight). Works
  // even when the private menu-bar impl is missing. Never re-dispatches the
  // Electron action (see FlashLeafWithoutAction).
  if (ItemTitle.length > 0 && TopItem.submenu != nil) {
    NSMenuItem *Leaf = FindLeafItem(TopItem.submenu, ItemTitle);
    if (Leaf != nil) {
      FlashLeafWithoutAction(Leaf);
      if (DebugEnabled()) {
        fprintf(stderr, "MenuFlash: leaf flash '%s' → '%s'\n",
                TopItem.title.UTF8String ?: "", Leaf.title.UTF8String ?: "");
      }
    } else if (DebugEnabled()) {
      fprintf(stderr, "MenuFlash: no leaf titled '%s' under '%s'\n",
              ItemTitle.UTF8String, TopItem.title.UTF8String ?: "");
    }
  } else if (!DidBarHighlight && TopItem.submenu != nil) {
    // No item title and no bar impl — flash the first enabled leaf as a
    // last-resort visual (still without re-firing a real action if we clear
    // it; first leaf might be a separator).
    for (NSMenuItem *It in TopItem.submenu.itemArray) {
      if (It.isSeparatorItem || !It.enabled)
        continue;
      FlashLeafWithoutAction(It);
      break;
    }
  }
}

/// Flash a top-level menu title; optional item title for leaf highlight.
/// itemTitleUtf8 may be NULL or empty.
__attribute__((visibility("default"))) void
FlashMenuItem(const char *TopTitleUtf8, const char *ItemTitleUtf8) {
  if (TopTitleUtf8 == NULL || TopTitleUtf8[0] == '\0')
    return;

  NSString *Top = [[NSString alloc] initWithUTF8String:TopTitleUtf8];
  NSString *Item = nil;
  if (ItemTitleUtf8 != NULL && ItemTitleUtf8[0] != '\0')
    Item = [[NSString alloc] initWithUTF8String:ItemTitleUtf8];
  if (Top.length == 0)
    return;

  void (^Block)(void) = ^{
    @autoreleasepool {
      DoFlash(Top, Item);
    }
  };

  if ([NSThread isMainThread])
    Block();
  else
    dispatch_async(dispatch_get_main_queue(), Block);
}

/// Back-compat: top-level title only.
__attribute__((visibility("default"))) void
FlashMenuTitle(const char *TitleUtf8) {
  FlashMenuItem(TitleUtf8, NULL);
}
