#ifndef __asio_h__
#define __asio_h__

#include "asiosys.h"

typedef struct ASIOTimeCode
{
    double speed;
    unsigned long timeCodeSamples;
    unsigned long flags;
    char future[64];
} ASIOTimeCode;

typedef struct ASIOTimeInfo
{
    double speed;
    unsigned long systemTime;
    unsigned long samplePosition;
    double sampleRate;
    unsigned long flags;
    char future[12];
} ASIOTimeInfo;

typedef struct ASIOTime
{
    long reserved[4];
    ASIOTimeInfo timeInfo;
    ASIOTimeCode timeCode;
} ASIOTime;

typedef struct ASIOBufferInfo
{
    long isInput;
    long channelNum;
    void *buffers[2];
} ASIOBufferInfo;

typedef struct ASIOCallbacks
{
    void (*bufferSwitch) (long doubleBufferIndex, long directProcess);
    void (*sampleRateDidChange) (double sRate);
    long (*asioMessage) (long selector, long value, void* message, double* opt);
    ASIOTime* (*bufferSwitchTimeInfo) (ASIOTime* params, long doubleBufferIndex, long directProcess);
} ASIOCallbacks;

typedef struct ASIOChannelInfo
{
    long channel;
    long isInput;
    long isActive;
    long channelGroup;
    long type;
    char name[32];
} ASIOChannelInfo;

typedef long ASIOError;
enum {
    ASE_OK = 0,
    ASE_SUCCESS = 0x3f487271,
    ASE_NotPresent = -1000,
    ASE_HWMalfunction,
    ASE_InvalidParameter,
    ASE_InvalidMode,
    ASE_SPNotAdvancing,
    ASE_NoClock,
    ASE_NoMemory
};

typedef long ASIOSampleType;
enum {
    ASIOSTInt16MSB = 0,
    ASIOSTInt24MSB = 1,
    ASIOSTInt32MSB = 2,
    ASIOSTFloat32MSB = 3,
    ASIOSTFloat64MSB = 4,
    ASIOSTInt32MSB16 = 8,
    ASIOSTInt32MSB18 = 9,
    ASIOSTInt32MSB20 = 10,
    ASIOSTInt32MSB24 = 11,
    ASIOSTInt16LSB = 16,
    ASIOSTInt24LSB = 17,
    ASIOSTInt32LSB = 18,
    ASIOSTFloat32LSB = 19,
    ASIOSTFloat64LSB = 20,
    ASIOSTInt32LSB16 = 24,
    ASIOSTInt32LSB18 = 25,
    ASIOSTInt32LSB20 = 26,
    ASIOSTDSDInt8LSB1 = 32,
    ASIOSTDSDInt8MSB1 = 33,
    ASIOSTDSDInt8NER8 = 34
};

typedef long ASIOMessageSelector;
enum {
    kAsioSelectorSupported = 1,
    kAsioEngineVersion,
    kAsioResetRequest,
    kAsioBufferSizeChange,
    kAsioResyncRequest,
    kAsioLatenciesChanged,
    kAsioSupportsTimeInfo,
    kAsioSupportsTimeCode,
    kAsioOverload
};

typedef double ASIOSampleRate;

#endif // __asio_h__
