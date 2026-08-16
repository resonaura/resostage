#ifndef __iasiodrv__
#define __iasiodrv__

#include "asio.h"

#if defined(_WIN32) || defined(WIN32)
#include <unknwn.h>

// {33D6C320-B3EC-11cf-9F8A-0020AF6B0B7A}
DEFINE_GUID(IID_IASIO, 0x33d6c320, 0xb3ec, 0x11cf, 0x9f, 0x8a, 0x0, 0x20, 0xaf, 0x6b, 0x0b, 0x7a);

interface IASIO : public IUnknown
{
    virtual ASIOBool init(void *sysHandle) = 0;
    virtual void getDriverName(char *name) = 0;
    virtual long getDriverVersion() = 0;
    virtual void getErrorMessage(char *string) = 0;
    virtual ASIOError start() = 0;
    virtual ASIOError stop() = 0;
    virtual ASIOError getChannels(long *numInputChannels, long *numOutputChannels) = 0;
    virtual ASIOError getLatencies(long *inputLatency, long *outputLatency) = 0;
    virtual ASIOError getBufferSize(long *minSize, long *maxSize, long *preferredSize, long *granularity) = 0;
    virtual ASIOError canSampleRate(ASIOSampleRate sampleRate) = 0;
    virtual ASIOError getSampleRate(ASIOSampleRate *sampleRate) = 0;
    virtual ASIOError setSampleRate(ASIOSampleRate sampleRate) = 0;
    virtual ASIOError getClockSources(ASIOClockSource *clocks, long *numSources) = 0;
    virtual ASIOError setClockSource(long reference) = 0;
    virtual ASIOError getSamplePosition(ASIOSamples *sPos, ASIOTimeStamp *tStamp) = 0;
    virtual ASIOError getChannelInfo(ASIOChannelInfo *info) = 0;
    virtual ASIOError createBuffers(ASIOBufferInfo *bufferInfos, long numChannels, long bufferSize, ASIOCallbacks *callbacks) = 0;
    virtual ASIOError disposeBuffers() = 0;
    virtual ASIOError controlPanel() = 0;
    virtual ASIOError future(long selector, void *opt) = 0;
    virtual ASIOError outputReady() = 0;
};

#endif // _WIN32

#endif // __iasiodrv__
