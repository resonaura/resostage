// macOS Touch Bar (optional hardware). Compile only on Apple.
#if defined(__APPLE__)

#import <AppKit/AppKit.h>
#import <objc/runtime.h>

#include "MacTouchBar.h"

#include <string>
#include <utility>

namespace {

// Identifiers for NSTouchBar items.
static NSString* const kTBPlayer = @"com.resostage.tb.player";
static NSString* const kTBMixer = @"com.resostage.tb.mixer";
static NSString* const kTBEditor = @"com.resostage.tb.editor";
static NSString* const kTBSettings = @"com.resostage.tb.settings";
static NSString* const kTBGroup = @"com.resostage.tb.screens";

// Associated-object keys (static addresses as unique keys).
static char kProviderKey;
static char kCallbackKey;

} // namespace

@interface ResoTouchBarProvider : NSObject <NSTouchBarDelegate>
@property (nonatomic, copy, nullable) void (^onSelect)(NSString* tabId);
@property (nonatomic, copy) NSString* activeTabId;
- (nullable NSTouchBar*)makeTouchBar API_AVAILABLE(macos(10.12.2));
@end

@implementation ResoTouchBarProvider

- (nullable NSTouchBar*)makeTouchBar {
    if (@available(macOS 10.12.2, *)) {
        NSTouchBar* bar = [[NSTouchBar alloc] init];
        bar.delegate = self;
        // Left-aligned screens group; flexible space pushes system proxy right.
        // (principalItemIdentifier would center the group — skip it.)
        bar.defaultItemIdentifiers = @[
            kTBGroup,
            NSTouchBarItemIdentifierFlexibleSpace,
            NSTouchBarItemIdentifierOtherItemsProxy,
        ];
        return bar;
    }
    return nil;
}

- (nullable NSTouchBarItem*)touchBar:(NSTouchBar*)touchBar
               makeItemForIdentifier:(NSTouchBarItemIdentifier)identifier API_AVAILABLE(macos(10.12.2)) {
    (void)touchBar;
    if (@available(macOS 10.12.2, *)) {
        if ([identifier isEqualToString:kTBGroup]) {
            NSMutableArray<NSTouchBarItem*>* items = [NSMutableArray array];
            auto addBtn = [&](NSString* ident, NSString* title, NSString* tabId) {
                NSCustomTouchBarItem* item =
                    [[NSCustomTouchBarItem alloc] initWithIdentifier:ident];
                NSButton* btn = [NSButton buttonWithTitle:title
                                                   target:self
                                                   action:@selector(onButton:)];
                btn.identifier = tabId;
                // Highlight active tab slightly.
                if (self.activeTabId != nil && [self.activeTabId isEqualToString:tabId]) {
                    btn.bezelColor = [NSColor controlAccentColor];
                }
                item.view = btn;
                [items addObject:item];
            };
            // SPA screens only — primary UI is always the webview; no separate
            // "Web" chrome toggle (that was a native-shell leftover).
            addBtn(kTBPlayer, @"Player", @"player");
            addBtn(kTBMixer, @"Mixer", @"mixer");
            addBtn(kTBEditor, @"Editor", @"editor");
            addBtn(kTBSettings, @"Settings", @"settings");

            NSGroupTouchBarItem* group =
                [NSGroupTouchBarItem groupItemWithIdentifier:kTBGroup items:items];
            return group;
        }
    }
    return nil;
}

- (void)onButton:(NSButton*)sender {
    if (self.onSelect == nil || sender.identifier == nil)
        return;
    self.activeTabId = sender.identifier;
    self.onSelect(sender.identifier);
    // Refresh bar so highlight updates (if still visible).
    // System rebuilds items on next makeItemForIdentifier.
}

@end

namespace resostage {
namespace {

NSWindow* windowFromHandle(void* nsViewOrWindow) {
    if (nsViewOrWindow == nullptr)
        return nil;
    id obj = (__bridge id)nsViewOrWindow;
    if ([obj isKindOfClass:[NSWindow class]])
        return (NSWindow*)obj;
    if ([obj isKindOfClass:[NSView class]])
        return [(NSView*)obj window];
    return nil;
}

} // namespace

void installMacTouchBar(void* nsViewOrWindow, std::function<void(const std::string& tabId)> onSelect) {
    if (@available(macOS 10.12.2, *)) {
        NSWindow* window = windowFromHandle(nsViewOrWindow);
        if (window == nil)
            return;

        ResoTouchBarProvider* provider = [[ResoTouchBarProvider alloc] init];
        provider.activeTabId = @"player";
        provider.onSelect = ^(NSString* tabId) {
            if (onSelect && tabId != nil)
                onSelect(std::string([tabId UTF8String]));
        };

        // Store provider so it lives with the window.
        objc_setAssociatedObject(window, &kProviderKey, provider, OBJC_ASSOCIATION_RETAIN_NONATOMIC);

        // Direct assignment — on non–Touch Bar Macs this is harmless (bar never shown).
        window.touchBar = [provider makeTouchBar];
    }
}

void uninstallMacTouchBar(void* nsViewOrWindow) {
    if (@available(macOS 10.12.2, *)) {
        NSWindow* window = windowFromHandle(nsViewOrWindow);
        if (window == nil)
            return;
        window.touchBar = nil;
        objc_setAssociatedObject(window, &kProviderKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
}

void setMacTouchBarActiveTab(void* nsViewOrWindow, const std::string& tabId) {
    fprintf(stderr, "[TB] setMacTouchBarActiveTab('%s') peer=%p\n",
            tabId.c_str(), nsViewOrWindow);
    if (tabId.empty())
        return;
    if (@available(macOS 10.12.2, *)) {
        NSWindow* window = windowFromHandle(nsViewOrWindow);
        fprintf(stderr, "[TB]   window=%p\n", (void*)window);
        if (window == nil)
            return;
        ResoTouchBarProvider* provider =
            objc_getAssociatedObject(window, &kProviderKey);
        fprintf(stderr, "[TB]   provider=%p\n", (void*)provider);
        if (provider == nil)
            return;
        NSString* oldTab = provider.activeTabId;
        provider.activeTabId = [NSString stringWithUTF8String:tabId.c_str()];
        fprintf(stderr, "[TB]   activeTabId '%s' -> '%s', rebuilding bar\n",
                [oldTab UTF8String], [provider.activeTabId UTF8String]);
        // Rebuild so bezel highlight refreshes.
        window.touchBar = [provider makeTouchBar];
        fprintf(stderr, "[TB]   bar replaced\n");
    }
}

} // namespace resostage

#else // !__APPLE__

#include "MacTouchBar.h"

namespace resostage {
void installMacTouchBar(void*, std::function<void(const std::string&)>) {}
void uninstallMacTouchBar(void*) {}
void setMacTouchBarActiveTab(void*, const std::string&) {}
} // namespace resostage

#endif
