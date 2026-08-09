#pragma once

#include "project/ProjectSchema.h"
#include "project/RecentProjects.h"

#include <juce_core/juce_core.h>

#include <string>
#include <unordered_map>
#include <vector>

namespace resostage {

// action name (e.g. "play", "stop", "next", "prev") -> key description string
// parseable by juce::KeyPress::createFromDescription (e.g. "space", "n", "cmd + p").
// Rig-wide (AppSettings), not project data -- see AppSettings::keybindings.
using KeyBindingMap = std::unordered_map<std::string, std::string>;

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

    // Which host audio API to drive: "ASIO", "CoreAudio", "ALSA", "JACK",
    // "Windows Audio"... Empty means "let the platform decide", which is what
    // every existing settings file says.
    //
    // Worth storing separately from the device name because the same box can
    // expose the same interface through two APIs with wildly different
    // latency -- an ASIO rig that falls back to WASAPI on the next launch is
    // a rig that misses its cues.
    std::string audioDeviceType;

    // Per-device memory of what was selected ON that device.
    //
    // Without this, switching to the laptop's built-in output to check
    // something and switching back leaves the interface on its default
    // stereo pair -- every wedge, sub and IEM feed silently unrouted, which
    // on a stage is discovered during the show. Keyed by device name, which
    // is what the OS gives back when the interface is plugged in again.
    struct DeviceProfile {
        double sampleRate = 0.0;
        int bufferSize = 0;
        std::vector<int> activeOutputChannels;
    };
    std::unordered_map<std::string, DeviceProfile> deviceProfiles;

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
