#include "AudioWorkgroup.h"

#include <CoreAudio/CoreAudio.h>
#include <os/workgroup.h>

namespace resostage {

namespace {
thread_local os_workgroup_t tlWorkgroup = nullptr;
thread_local os_workgroup_join_token_s tlToken{};
thread_local bool tlJoined = false;
} // namespace

bool joinCurrentThreadToDefaultOutputWorkgroup() {
    // Fallback only. Prefer AudioEngine::joinCurrentThreadToDeviceWorkgroup,
    // which uses the workgroup of the device actually rendering.
    //
    // This one asks for kAudioHardwarePropertyDefaultOutputDevice, and on any
    // rig where playback does not go to the system default -- an interface
    // while the Mac's own output stays default, which is the normal stage
    // setup -- that is the workgroup of a device that is not even running.
    // Joining it tells the scheduler nothing, so the thread stays an ordinary
    // one and lands on an E-core.
    if (tlJoined)
        return true; // already joined on this thread; avoid double-join

    AudioObjectPropertyAddress deviceAddr = {kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal,
                                              kAudioObjectPropertyElementMain};
    AudioDeviceID deviceId = kAudioObjectUnknown;
    UInt32 deviceIdSize = sizeof(deviceId);
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &deviceAddr, 0, nullptr, &deviceIdSize, &deviceId) != noErr)
        return false;
    if (deviceId == kAudioObjectUnknown)
        return false;

    AudioObjectPropertyAddress workgroupAddr = {kAudioDevicePropertyIOThreadOSWorkgroup, kAudioObjectPropertyScopeGlobal,
                                                 kAudioObjectPropertyElementMain};
    os_workgroup_t workgroup = nullptr;
    UInt32 workgroupSize = sizeof(workgroup);
    if (AudioObjectGetPropertyData(deviceId, &workgroupAddr, 0, nullptr, &workgroupSize, &workgroup) != noErr)
        return false;
    if (workgroup == nullptr)
        return false;

    os_workgroup_join_token_s token;
    const int result = os_workgroup_join(workgroup, &token);
    if (result != 0)
        return false;

    tlWorkgroup = workgroup;
    tlToken = token;
    tlJoined = true;
    return true;
}

void leaveCurrentThreadWorkgroupIfJoined() {
    if (!tlJoined)
        return;
    os_workgroup_leave(tlWorkgroup, &tlToken);
    tlJoined = false;
    tlWorkgroup = nullptr;
}

} // namespace resostage
