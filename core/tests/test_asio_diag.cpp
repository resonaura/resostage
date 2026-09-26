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
        const auto ins = t->getDeviceNames(true);
        std::cout << "  Inputs count: " << ins.size() << "\n";
        for (const auto& dev : ins) {
            std::cout << "   - In: " << dev.toRawUTF8() << "\n";
        }
    }
    std::cout << "========================================\n\n";

    mgr.initialiseWithDefaultDevices(0, 2);
    if (auto* cur = mgr.getCurrentDeviceTypeObject()) {
        std::cout << "Current Device Type: " << cur->getTypeName().toRawUTF8() << "\n";
        const auto inNames = cur->getDeviceNames(true);
        std::cout << "Current Device Type Inputs count (without scan): " << inNames.size() << "\n";
        for (const auto& dev : inNames) {
            std::cout << "   - CurIn: " << dev.toRawUTF8() << "\n";
        }
        cur->scanForDevices();
        const auto inNamesScanned = cur->getDeviceNames(true);
        std::cout << "Current Device Type Inputs count (WITH scan): " << inNamesScanned.size() << "\n";
        for (const auto& dev : inNamesScanned) {
            std::cout << "   - CurInScanned: " << dev.toRawUTF8() << "\n";
        }
    }
}
