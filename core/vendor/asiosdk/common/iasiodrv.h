#ifndef __iasiodrv__
#define __iasiodrv__

#include "asio.h"

#if defined(_WIN32) || defined(WIN32)
#include <unknwn.h>

// {33D6C320-B3EC-11cf-9F8A-0020AF6B0B7A}
DEFINE_GUID(IID_IASIO, 0x33d6c320, 0xb3ec, 0x11cf, 0x9f, 0x8a, 0x0, 0x20, 0xaf, 0x6b, 0x0b, 0x7a);

interface IASIO : public IUnknown
{
    virtual long init(void *sysHandle) = 0;
    virtual void getDriverName(char *name) = 0;
    virtual long getDriverVersion() = 0;
    virtual void getErrorMessage(char *string) = 0;
    virtual long start() = 0;
    virtual long stop() = 0;
    virtual long getChannels(long *numInputChannels, long *numOutputChannels) = 0;
    virtual long getLatencies(long *inputLatency, long *outputLatency) = 0;
    virtual long getBufferSize(long *minSize, long *maxSize, long *preferredSize, long *granularity) = 0;
    virtual long canSampleRate(double sampleRate) = 0;
    virtual long getSampleRate(double *sampleRate) = 0;
    virtual long setSampleRate(double sampleRate) = 0;
    virtual long getClockSources(void *clocks, long *numSources) = 0;
    virtual long setClockSource(long reference) = 0;
    virtual long getSamplePosition(void *sPos, void *tStamp) = 0;
    virtual long getChannelInfo(ASIOChannelInfo *info) = 0;
    virtual long createBuffers(ASIOBufferInfo *bufferInfos, long numChannels, long bufferSize, ASIOCallbacks *callbacks) = 0;
    virtual long disposeBuffers() = 0;
    virtual long controlPanel() = 0;
    virtual long future(long selector, void *opt) = 0;
    virtual long outputReady() = 0;
};

#endif // _WIN32

#endif // __iasiodrv__
