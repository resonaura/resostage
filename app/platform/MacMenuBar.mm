#if defined(__APPLE__)

#import <AppKit/AppKit.h>

#include "MacMenuBar.h"

#include <unordered_map>

// ---------------------------------------------------------------------------
// ObjC helper – must live outside the C++ namespace.
// ---------------------------------------------------------------------------
@interface MenuActionTarget : NSObject
- (instancetype)initWithHandler:(void (^)(NSString*))handler;
- (void)menuAction:(id)sender;
@property (nonatomic, copy) void (^handler)(NSString*);
@end

@implementation MenuActionTarget
- (instancetype)initWithHandler:(void (^)(NSString*))handler {
    self = [super init];
    if (self) _handler = [handler copy];
    return self;
}
- (void)dealloc {
    [_handler release];
    [super dealloc];
}
- (void)menuAction:(id)sender {
    NSMenuItem* item = (NSMenuItem*)sender;
    NSString* action = [item representedObject];
    if (action && _handler)
        _handler(action);
}
@end

namespace resostage {

namespace {

MacMenuBarCallback menuCallback;

// +1 retain held by us so the target survives menu replacement; released in
// uninstallMacMenuBar().  NSMenuItems that point to this also retain it, but
// they are released when the old menu is replaced.
id globalTarget = nil;
NSMenuItem* undoItem = nil;
NSMenuItem* redoItem = nil;
NSMenuItem* openRecentItem = nil; // File > Open Recent, submenu rebuilt by updateMacMenuRecentProjects

// Menu items whose key equivalents are driven by user-configured keyBindings.
static NSMutableDictionary* dynamicItems = nil;  // action → NSMenuItem

// Every item with a real actionId (transport/mode/section/undo-redo/project
// lifecycle/recent-projects alike) -- lookup table for flashMacMenuAction().
// Broader than dynamicItems on purpose: flashing isn't about key-equivalent
// syncing, so items with a fixed hardcoded shortcut (New/Open/Save…) still
// belong here.
static NSMutableDictionary* flashableItems = nil; // action → NSMenuItem
static NSMutableDictionary* flashTimers = nil;    // action → pending-clear NSTimer

static NSMenuItem* makeItem(NSString* title, NSString* actionId,
                             NSString* keyEq, NSEventModifierFlags modMask,
                             id tgt) {
    NSMenuItem* item = [[NSMenuItem alloc] initWithTitle:title
                                                  action:@selector(menuAction:)
                                           keyEquivalent:keyEq ? keyEq : @""];
    if (actionId) {
        [item setRepresentedObject:actionId];
        if (flashableItems == nil)
            flashableItems = [[NSMutableDictionary alloc] init];
        [flashableItems setObject:item forKey:actionId];
    }
    if (modMask != 0)
        [item setKeyEquivalentModifierMask:modMask];
    [item setTarget:tgt];
    return [item autorelease];
}

// ── keybinding-description → ObjC key-equivalent helpers ──────────────────

static void setKeyEquivForBinding(NSMenuItem* item, const std::string& desc) {
    if (desc.empty()) {
        [item setKeyEquivalent:@""];
        [item setKeyEquivalentModifierMask:0];
        return;
    }

    NSEventModifierFlags mods = 0;
    std::string key;

    // Split "cmd + shift + z" into tokens
    size_t pos = 0;
    std::string rem = desc;
    while (true) {
        auto plus = rem.find(" + ");
        std::string token = (plus == std::string::npos) ? rem : rem.substr(0, plus);
        // Trim
        while (!token.empty() && token.front() == ' ') token.erase(token.begin());
        while (!token.empty() && token.back() == ' ') token.pop_back();

        if (token == "cmd")
            mods |= NSEventModifierFlagCommand;
        else if (token == "shift")
            mods |= NSEventModifierFlagShift;
        else if (token == "alt")
            mods |= NSEventModifierFlagOption;
        else if (token == "ctrl")
            mods |= NSEventModifierFlagControl;
        else {
            key = token;
            break;
        }

        if (plus == std::string::npos) break;
        rem = rem.substr(plus + 3);
    }

    NSString* keyEq = nil;
    if (key == "space")
        keyEq = @" ";
    else if (key == "escape")
        keyEq = @"\e";
    // Apple NSEvent.h: NSF1FunctionKey=0xF704 … NSF4FunctionKey=0xF707
    else if (key == "f1")       keyEq = @"\U0000F704";
    else if (key == "f2")       keyEq = @"\U0000F705";
    else if (key == "f3")       keyEq = @"\U0000F706";
    else if (key == "f4")       keyEq = @"\U0000F707";
    else if (key == "end")      keyEq = @"\U0000F72B";
    else if (key == "home")     keyEq = @"\U0000F729";
    else if (key == "left")     keyEq = @"\U0000F702";
    else if (key == "right")    keyEq = @"\U0000F703";
    else if (key == "pageup")   keyEq = @"\U0000F72C";
    else if (key == "pagedown") keyEq = @"\U0000F72D";
    else if (key == "delete")   keyEq = @"\u007F";
    else if (key == "return")   keyEq = @"\r";
    else if (key == "tab")      keyEq = @"\t";
    else if (key.size() == 1)
        keyEq = [NSString stringWithFormat:@"%c", key[0]];
    else
        keyEq = @"";

    [item setKeyEquivalent:keyEq ?: @""];
    [item setKeyEquivalentModifierMask:mods];
    // Prevent macOS 12+ from auto-localizing our custom function-key
    // equivalents (e.g. F1-F4 -> arrow symbols on some layouts).
    if (@available(macOS 12.0, *))
        item.allowsAutomaticKeyEquivalentLocalization = NO;
}

/// Mark |item| as having a key equivalent driven by the binding for |action|.
/// Future calls to updateMacMenuKeyBindings will update this item.
/// Returns |item| for convenient chaining (e.g. addItem:).
static NSMenuItem* makeDynamicItem(const std::string& action, NSMenuItem* item) {
    if (dynamicItems == nil)
        dynamicItems = [[NSMutableDictionary alloc] init];
    NSString* key = [NSString stringWithUTF8String:action.c_str()];
    [dynamicItems setObject:item forKey:key];
    return item;
}

static NSMenuItem* makeSep() {
    return [NSMenuItem separatorItem];
}

} // namespace

void installMacMenuBar(MacMenuBarCallback onAction,
    const std::unordered_map<std::string, std::string>* initialBindings) {
    uninstallMacMenuBar();
    menuCallback = std::move(onAction);
    if (!menuCallback)
        return;

    MenuActionTarget* tgt = [[MenuActionTarget alloc]
        initWithHandler:^(NSString* action) {
            if (menuCallback) {
                const char* utf8 = [action UTF8String];
                menuCallback(std::string(utf8 ? utf8 : ""));
            }
        }];
    globalTarget = tgt;

    NSMenu* mainMenu = [[[NSMenu alloc] initWithTitle:@""] autorelease];

    // ── Application (ResoStage) ───────────────────────────────────────────
    {
        NSMenu* m = [[[NSMenu alloc] initWithTitle:@"ResoStage"] autorelease];
        {
            NSMenuItem* aboutItem = [[[NSMenuItem alloc]
                initWithTitle:@"About ResoStage"
                action:@selector(orderFrontStandardAboutPanel:)
                keyEquivalent:@""] autorelease];
            [aboutItem setTarget:nil];
            [m addItem:aboutItem];
        }
        [m addItem:makeSep()];
        [m addItem:makeItem(@"Quit ResoStage", @"quit",
                             @"q", NSEventModifierFlagCommand, tgt)];

        NSMenuItem* parent = [[[NSMenuItem alloc]
            initWithTitle:@"ResoStage" action:nil keyEquivalent:@""] autorelease];
        [parent setSubmenu:m];
        [mainMenu addItem:parent];
    }

    // ── File ──────────────────────────────────────────────────────────────
    {
        NSMenu* m = [[[NSMenu alloc] initWithTitle:@"File"] autorelease];
        [m addItem:makeItem(@"New Project", @"new_project",
                             @"n", NSEventModifierFlagCommand, tgt)];
        [m addItem:makeItem(@"Open\u2026", @"open_project",
                             @"o", NSEventModifierFlagCommand, tgt)];
        {
            NSMenu* recentMenu = [[[NSMenu alloc] initWithTitle:@"Open Recent"] autorelease];
            NSMenuItem* placeholder = [[[NSMenuItem alloc]
                initWithTitle:@"No Recent Projects" action:nil keyEquivalent:@""] autorelease];
            [placeholder setEnabled:NO];
            [recentMenu addItem:placeholder];

            openRecentItem = [[NSMenuItem alloc]
                initWithTitle:@"Open Recent" action:nil keyEquivalent:@""];
            [openRecentItem setSubmenu:recentMenu];
            [m addItem:openRecentItem];
        }
        [m addItem:makeSep()];
        [m addItem:makeItem(@"Save", @"save_project",
                             @"s", NSEventModifierFlagCommand, tgt)];
        [m addItem:makeItem(@"Save As\u2026", @"save_project_as",
                             @"s", NSEventModifierFlagCommand | NSEventModifierFlagShift, tgt)];
        [m addItem:makeSep()];
        [m addItem:makeItem(@"Import Song Folder\u2026", @"import_song_folder",
                             nil, 0, tgt)];

        NSMenuItem* parent = [[[NSMenuItem alloc]
            initWithTitle:@"File" action:nil keyEquivalent:@""] autorelease];
        [parent setSubmenu:m];
        [mainMenu addItem:parent];
    }

    // ── Edit ──────────────────────────────────────────────────────────────
    {
        NSMenu* m = [[[NSMenu alloc] initWithTitle:@"Edit"] autorelease];
        undoItem = [makeItem(@"Undo", @"undo",
                             nil, 0, tgt) retain];
        redoItem = [makeItem(@"Redo", @"redo",
                             nil, 0, tgt) retain];
        makeDynamicItem("undo", undoItem);
        makeDynamicItem("redo", redoItem);
        [m addItem:undoItem];
        [m addItem:redoItem];

        NSMenuItem* parent = [[[NSMenuItem alloc]
            initWithTitle:@"Edit" action:nil keyEquivalent:@""] autorelease];
        [parent setSubmenu:m];
        [mainMenu addItem:parent];
    }

    // ── View ──────────────────────────────────────────────────────────────
    {
        NSMenu* m = [[[NSMenu alloc] initWithTitle:@"View"] autorelease];
        [m addItem:makeDynamicItem("mode_player", makeItem(@"Player", @"mode_player",
                             nil, 0, tgt))];
        [m addItem:makeDynamicItem("mode_mixer", makeItem(@"Mixer", @"mode_mixer",
                             nil, 0, tgt))];
        [m addItem:makeDynamicItem("mode_editor", makeItem(@"Editor", @"mode_editor",
                             nil, 0, tgt))];
        [m addItem:makeDynamicItem("mode_settings", makeItem(@"Settings", @"mode_settings",
                             nil, 0, tgt))];

        NSMenuItem* parent = [[[NSMenuItem alloc]
            initWithTitle:@"View" action:nil keyEquivalent:@""] autorelease];
        [parent setSubmenu:m];
        [mainMenu addItem:parent];
    }

    // ── Transport ─────────────────────────────────────────────────────────
    {
        NSMenu* m = [[[NSMenu alloc] initWithTitle:@"Transport"] autorelease];
        [m addItem:makeDynamicItem("play", makeItem(@"Play / Pause", @"play",
                             nil, 0, tgt))];
        [m addItem:makeDynamicItem("stop", makeItem(@"Stop", @"stop",
                             nil, 0, tgt))];
        [m addItem:makeDynamicItem("stop_to_start", makeItem(@"Stop to Start", @"stop_to_start",
                             nil, 0, tgt))];
        [m addItem:makeSep()];
        [m addItem:makeDynamicItem("next", makeItem(@"Next Song", @"next",
                             nil, 0, tgt))];
        [m addItem:makeDynamicItem("prev", makeItem(@"Previous Song", @"prev",
                             nil, 0, tgt))];
        [m addItem:makeSep()];
        [m addItem:makeDynamicItem("section_prev", makeItem(@"Previous Section", @"section_prev",
                             nil, 0, tgt))];
        [m addItem:makeDynamicItem("section_next", makeItem(@"Next Section", @"section_next",
                             nil, 0, tgt))];
        [m addItem:makeSep()];
        [m addItem:makeDynamicItem("bar_prev", makeItem(@"Previous Bar", @"bar_prev",
                             nil, 0, tgt))];
        [m addItem:makeDynamicItem("bar_next", makeItem(@"Next Bar", @"bar_next",
                             nil, 0, tgt))];

        NSMenuItem* parent = [[[NSMenuItem alloc]
            initWithTitle:@"Transport" action:nil keyEquivalent:@""] autorelease];
        [parent setSubmenu:m];
        [mainMenu addItem:parent];
    }

    // ── Window ────────────────────────────────────────────────────────────
    {
        NSMenu* m = [[[NSMenu alloc] initWithTitle:@"Window"] autorelease];
        {
            NSMenuItem* item = [[[NSMenuItem alloc]
                initWithTitle:@"Minimize"
                action:@selector(miniaturize:)
                keyEquivalent:@"m"] autorelease];
            [item setKeyEquivalentModifierMask:NSEventModifierFlagCommand];
            [item setTarget:nil];
            [m addItem:item];
        }
        {
            NSMenuItem* item = [[[NSMenuItem alloc]
                initWithTitle:@"Zoom"
                action:@selector(performZoom:)
                keyEquivalent:@""] autorelease];
            [item setTarget:nil];
            [m addItem:item];
        }

        NSMenuItem* parent = [[[NSMenuItem alloc]
            initWithTitle:@"Window" action:nil keyEquivalent:@""] autorelease];
        [parent setSubmenu:m];
        [mainMenu addItem:parent];
    }

    [NSApp setMainMenu:mainMenu];
    if (initialBindings)
        updateMacMenuKeyBindings(*initialBindings);
}

void uninstallMacMenuBar() {
    [NSApp setMainMenu:[[[NSMenu alloc] initWithTitle:@""] autorelease]];
    if (undoItem) { [undoItem release]; undoItem = nil; }
    if (redoItem) { [redoItem release]; redoItem = nil; }
    if (openRecentItem) { [openRecentItem release]; openRecentItem = nil; }
    if (flashTimers) {
        for (NSString* key in flashTimers)
            [(NSTimer*)flashTimers[key] invalidate];
        [flashTimers release];
        flashTimers = nil;
    }
    if (flashableItems) { [flashableItems release]; flashableItems = nil; }
    if (globalTarget) { [globalTarget release]; globalTarget = nil; }
    if (dynamicItems) { [dynamicItems release]; dynamicItems = nil; }
    menuCallback = nullptr;
}

/// Update the key equivalent shown in the menu bar to match the user's
/// configured bindings. Called whenever settings change.
void updateMacMenuKeyBindings(
    const std::unordered_map<std::string, std::string>& bindings) {
    for (NSString* action in dynamicItems) {
        NSMenuItem* item = [dynamicItems objectForKey:action];
        std::string key([action UTF8String]);
        auto it = bindings.find(key);
        if (it != bindings.end() && !it->second.empty()) {
            setKeyEquivForBinding(item, it->second);
        } else {
            [item setKeyEquivalent:@""];
            [item setKeyEquivalentModifierMask:0];
        }
    }
}

void updateMacMenuUndoRedo(bool canUndo, bool canRedo,
                            const std::string& undoLabel,
                            const std::string& redoLabel) {
    if (undoItem) {
        [undoItem setTitle:canUndo
            ? [NSString stringWithFormat:@"Undo %s", undoLabel.c_str()]
            : @"Undo"];
        [undoItem setEnabled:canUndo];
    }
    if (redoItem) {
        [redoItem setTitle:canRedo
            ? [NSString stringWithFormat:@"Redo %s", redoLabel.c_str()]
            : @"Redo"];
        [redoItem setEnabled:canRedo];
    }
}

void flashMacMenuAction(const std::string& actionId) {
    if (flashableItems == nil)
        return;
    NSString* key = [NSString stringWithUTF8String:actionId.c_str()];
    if ([flashableItems objectForKey:key] == nil)
        return;

    if (flashTimers == nil)
        flashTimers = [[NSMutableDictionary alloc] init];
    // A repeat trigger while still lit restarts the clear timer instead of
    // flickering off and back on between presses.
    NSTimer* existing = [flashTimers objectForKey:key];
    if (existing != nil)
        [existing invalidate];

    [(NSMenuItem*)[flashableItems objectForKey:key] setState:NSControlStateValueOn];

    NSTimer* timer = [NSTimer scheduledTimerWithTimeInterval:0.45
                                                       repeats:NO
                                                         block:^(NSTimer*) {
        // Re-look-up rather than capture the item directly -- a menu rebuild
        // (e.g. Open Recent repopulating) during the pending window would
        // otherwise leave this clearing a stale, already-replaced NSMenuItem.
        NSMenuItem* current = [flashableItems objectForKey:key];
        if (current != nil)
            [current setState:NSControlStateValueOff];
        [flashTimers removeObjectForKey:key];
    }];
    [flashTimers setObject:timer forKey:key];
}

void updateMacMenuRecentProjects(
    const std::vector<std::pair<std::string, std::string>>& recents) {
    if (openRecentItem == nil)
        return;

    NSMenu* recentMenu = [[[NSMenu alloc] initWithTitle:@"Open Recent"] autorelease];
    if (recents.empty()) {
        NSMenuItem* placeholder = [[[NSMenuItem alloc]
            initWithTitle:@"No Recent Projects" action:nil keyEquivalent:@""] autorelease];
        [placeholder setEnabled:NO];
        [recentMenu addItem:placeholder];
    } else {
        for (const auto& [path, label] : recents) {
            NSString* actionId = [NSString stringWithUTF8String:("open_recent:" + path).c_str()];
            NSString* title = [NSString stringWithUTF8String:label.c_str()];
            [recentMenu addItem:makeItem(title, actionId, nil, 0, globalTarget)];
        }
        [recentMenu addItem:makeSep()];
        [recentMenu addItem:makeItem(@"Clear Menu", @"clear_recent_projects", nil, 0, globalTarget)];
    }
    [openRecentItem setSubmenu:recentMenu];
}

} // namespace resostage

#endif
