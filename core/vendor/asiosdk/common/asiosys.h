#ifndef __asiosys__
#define __asiosys__

#if defined(_WIN32) || defined(WIN32)
  #define ASIO_WINDOWS 1
  #ifndef WIN32_LEAN_AND_MEAN
    #define WIN32_LEAN_AND_MEAN
  #endif
  #include <windows.h>
  #include <mmsystem.h>
#endif

#endif // __asiosys__
