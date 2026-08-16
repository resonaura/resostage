#include "doctest.h"
#include <juce_audio_devices/juce_audio_devices.h>
#include <iostream>

TEST_CASE("ASIO Driver Diagnostics") {
    juce::AudioDeviceManager mgr;
    juce::OwnedArray<juce::AudioIODeviceType> types;
    mgr.createAudioDeviceTypes(types);

    std::cout << "\n========================================\n";
    std::cout << "  DIAGNOSTIC AUDIO DRIVERS LIST:\n";
    std::cout << "========================================\n";
    for (auto* t : types) {
        if (t == nullptr) continue;
        std::cout << "Driver: " << t->getTypeName().toRawUTF8() << "\n";
        t->scanForDevices();
        const auto outs = t->getDeviceNames(false);
        std::cout << "  Outputs count: " << outs.size() << "\n";
        for (const auto& dev : outs) {
            std::cout << "   - " << dev.toRawUTF8() << "\n";
        }
    }
    std::cout << "========================================\n\n";
}
