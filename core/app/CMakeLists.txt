file(READ "${CMAKE_CURRENT_SOURCE_DIR}/Info.plist.in" INFO_PLIST_CONTENT)

# Menu-bar tray icon (platform/TrayIcon.cpp) for when this process runs
# headless with no Dock icon of its own -- embedded as binary data (it's a
# handful of KB) rather than a runtime file read, so it's not tied to any
# particular Resources/ layout. A pre-rasterized, tightly-cropped PNG (via
# the system's own AppKit SVG renderer, `icons/icon.svg` -> `icons/tray.png`
# -- trimmed to the glyph's own bounding box + a small margin so JUCE's
# fixed 20x20pt tray icon target isn't mostly empty space), not the raw SVG:
# JUCE's own SVG parser is a much more limited implementation than a real
# browser/WebKit renderer and silently produced a blank Drawable for this
# file's <g transform="matrix(...)"> + style="fill-rule:evenodd" syntax.
juce_add_binary_data(ResoStageTrayIconData
  SOURCES "${CMAKE_SOURCE_DIR}/../icons/tray.png"
)

juce_add_gui_app(ResoStage
  PRODUCT_NAME "ResoStage Core"
  COMPANY_NAME "Resonaura"
  # BUNDLE_ID intentionally distinct from the Electron shell's
  # com.resonaura.resostage: this bundle now ships nested inside the
  # shell's own .app (Contents/Resources/), and two separate .app bundles
  # sharing one CFBundleIdentifier confuses LaunchServices (icon caching,
  # Spotlight, "which app owns this ID").
  BUNDLE_ID "com.resonaura.resostage.core"
  ICON_BIG "${CMAKE_SOURCE_DIR}/../icons/app.png"
  PLIST_TO_MERGE "${INFO_PLIST_CONTENT}"
)

target_sources(ResoStage PRIVATE
  Main.cpp
  main/MainComponent.cpp
  main/MainComponentBuilder.cpp
  main/MainComponentSettings.cpp
  main/MainComponentTimeline.cpp
  main/MainComponentLighting.cpp
  config/AppSettings.cpp
  engine/AudioEngine.cpp
  engine/AudioEngineImport.cpp
  engine/AudioEnginePeaks.cpp
  engine/AudioEngineProject.cpp
  engine/AudioEngineRouting.cpp
  engine/AudioEngineTransport.cpp
  light/LightEngine.cpp
  light/LightHardwareServer.cpp
  midi/CoreMidiDispatcher.cpp
  midi/CoreMidiInputListener.cpp
  events/EventDispatcher.cpp
  platform/AudioWorkgroup.cpp
  platform/MenuModel.cpp
  platform/ProcessPriority.cpp
  platform/TrayIcon.cpp
  server/WebServer.cpp
)

if(APPLE)
  target_sources(ResoStage PRIVATE platform/MacShellMode.mm)
  set(FILE_ICON "${CMAKE_SOURCE_DIR}/../icons/file.icns")
  set_source_files_properties(${FILE_ICON} PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
  target_sources(ResoStage PRIVATE ${FILE_ICON})
endif()

target_compile_definitions(ResoStage
  PRIVATE
    JUCE_USE_CURL=0
    JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:ResoStage,JUCE_PRODUCT_NAME>"
    JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:ResoStage,JUCE_VERSION>"
)

target_link_libraries(ResoStage
  PRIVATE
    resostage_engine
    websockets
    ResoStageTrayIconData
    juce::juce_audio_basics
    juce::juce_audio_devices
    juce::juce_audio_utils
    juce::juce_core
    juce::juce_data_structures
    juce::juce_events
    juce::juce_graphics
    juce::juce_gui_basics
    juce::juce_gui_extra
  PUBLIC
    juce::juce_recommended_config_flags
    juce::juce_recommended_lto_flags
    juce::juce_recommended_warning_flags
)

# Flat include roots so existing #include "AudioEngine.h" / "MainComponent.h"
# etc. keep working after sources moved into single-word subfolders (engine/,
# main/, config/, light/). Quoted includes also resolve relative to the
# including file's directory (same-folder fragments like AudioEngineMembers.h).
target_include_directories(ResoStage PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}
  ${CMAKE_CURRENT_SOURCE_DIR}/engine
  ${CMAKE_CURRENT_SOURCE_DIR}/main
  ${CMAKE_CURRENT_SOURCE_DIR}/config
  ${CMAKE_CURRENT_SOURCE_DIR}/light
  ${libwebsockets_SOURCE_DIR}/include
  ${libwebsockets_BINARY_DIR}/include
)

if(APPLE)
  target_link_libraries(ResoStage PRIVATE
    "-framework CoreMIDI"
    "-framework CoreFoundation"
    "-framework CoreAudio"
    "-framework AppKit"
  )
endif()

target_compile_features(ResoStage PRIVATE cxx_std_20)
