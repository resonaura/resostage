#pragma once

#include "project/ProjectSchema.h"
#include "project/RecentProjects.h"

#include <juce_core/juce_core.h>

#include <string>
#include <vector>

namespace resostage {

// Rig-wide preferences: hotkeys, MIDI bindings, and the audio/MIDI device
// setup. These describe how the physical rig is wired up for a live show,
// not any one song set -- a performer keeps the same footswitch and hotkeys
// across every .rsnraset they load, so this lives outside the project file,
// in one global file under Application Support (~/Library/Application
// Support/ResoStage/settings.json on macOS; platform-equivalent elsewhere).
// See appSettingsFile() / loadAppSettings() / saveAppSettings().
struct AppSettings {
    KeyBindingMap keybindings;
    std::vector<MidiMapping> midiMappings;

    // Audio device setup. Empty/zero fields mean "no saved preference yet"
    // -- callers fall back to JUCE's own default-device selection.
    std::string outputDeviceName;
    double sampleRate = 0.0;
    int bufferSize = 0;
    std::vector<int> activeOutputChannels; // indices into the device's channel list

    std::string midiOutputName;
    std::string midiInputName;
    bool virtualMidiPortEnabled = false;

    // Which engine drives the on-screen UI: "browser" (default -- the SPA
    // opens in the system browser against the embedded backend) or "electron"
    // (the Chromium-based Electron shell in electron/, its own window with the
    // native menu bar/Touch Bar). Set from Settings > UI; takes effect on next
    // launch (the setting itself can't be swapped hot). The JUCE core is
    // headless either way.
    std::string uiRenderEngine = "browser";

    // Most-recent-first, capped at kMaxRecentProjects (see RecentProjects.h).
    std::vector<RecentProjectEntry> recentProjects;
};

// ~/Library/Application Support/ResoStage/settings.json (platform-equivalent
// elsewhere via juce::File::getSpecialLocation).
juce::File appSettingsFile();

// Best-effort: returns a default-constructed AppSettings if the file is
// missing or fails to parse (first launch, or a corrupt file) rather than
// failing the whole app startup over a preferences file.
AppSettings loadAppSettings();

bool saveAppSettings(const AppSettings& settings, std::string& error);

} // namespace resostage
