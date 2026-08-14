// Windows native build - no-op (macOS dylibs not needed on Windows)
// MenuFlash/Haptics are macOS AppKit dylibs accessed via koffi
// On Windows, equivalent functionality uses different native APIs or is not needed.

console.log("skip native mac modules (not on darwin)");
process.exit(0);