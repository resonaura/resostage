/* Hand-written replacement for the miniz_export.h that miniz's own CMake build
 * normally generates via GenerateExportHeader. We always build/link miniz
 * statically inside this project, so no dllexport/visibility handling is needed. */
#ifndef MINIZ_EXPORT_H
#define MINIZ_EXPORT_H

#define MINIZ_EXPORT
#define MINIZ_NO_EXPORT

#endif
