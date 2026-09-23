#pragma once

#include <juce_core/juce_core.h>

namespace resostage {

/** Device-local storage shared by the scanner and runtime host. */
inline juce::File pluginDataDirectory() {
    auto root = juce::File::getSpecialLocation(
        juce::File::userApplicationDataDirectory);
#if JUCE_MAC
    root = root.getChildFile("Application Support");
#endif
    return root.getChildFile("ResoStage").getChildFile("Plugins");
}

inline juce::File pluginRegistryFile() {
    return pluginDataDirectory().getChildFile("known-plugins.xml");
}

} // namespace resostage
