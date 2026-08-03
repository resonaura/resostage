file(READ "${CMAKE_CURRENT_SOURCE_DIR}/Info.plist.in" INFO_PLIST_CONTENT)

juce_add_gui_app(ResoStage
  PRODUCT_NAME "ResoStage"
  COMPANY_NAME "Resonaura"
  BUNDLE_ID "com.resonaura.resostage"
  ICON_BIG "${CMAKE_SOURCE_DIR}/icons/app.png"
  PLIST_TO_MERGE "${INFO_PLIST_CONTENT}"
)

target_sources(ResoStage PRIVATE
  Main.cpp
  MainComponent.cpp
  MainComponentBuilder.cpp
  MainComponentSettings.cpp
  MainComponentTimeline.cpp
  MainComponentLighting.cpp
  AppSettings.cpp
  AudioEngine.cpp
  LightEngine.cpp
  midi/CoreMidiDispatcher.cpp
  midi/CoreMidiInputListener.cpp
  events/EventDispatcher.cpp
  platform/AudioWorkgroup.cpp
  platform/ProcessPriority.cpp
  web/WebServer.cpp
)

if(APPLE)
  target_sources(ResoStage PRIVATE platform/MacTouchBar.mm platform/MacKeyMonitor.mm platform/MacMenuBar.mm)
  set(FILE_ICON "${CMAKE_SOURCE_DIR}/icons/file.icns")
  set_source_files_properties(${FILE_ICON} PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
  target_sources(ResoStage PRIVATE ${FILE_ICON})
endif()

target_compile_definitions(ResoStage
  PRIVATE
    JUCE_WEB_BROWSER=1
    JUCE_USE_CURL=0
    JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:ResoStage,JUCE_PRODUCT_NAME>"
    JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:ResoStage,JUCE_VERSION>"
)

target_link_libraries(ResoStage
  PRIVATE
    resostage_engine
    websockets
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

target_include_directories(ResoStage PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}
  ${libwebsockets_SOURCE_DIR}/include
  ${libwebsockets_BINARY_DIR}/include
)

if(APPLE)
  target_link_libraries(ResoStage PRIVATE
    "-framework CoreMIDI"
    "-framework CoreFoundation"
    "-framework CoreAudio"
    "-framework AppKit"
    "-framework WebKit"
  )
endif()

target_compile_features(ResoStage PRIVATE cxx_std_20)

# ---------------------------------------------------------------------------
# Chromium Embedded Framework (optional alternate embedded-UI renderer --
# see vendor/cef/CMakeLists.txt and the CEF integration milestones). This
# wires up the process-lifetime bootstrap (app/cef/CefLifecycle.*, hooked
# into Main.cpp) and assembles the helper bundles/framework into the real
# ResoStage.app bundle. It does NOT yet make the app render anything through
# CEF -- MainComponent still always constructs the WKWebView-backed
# DevOrEmbeddedWebView (a CEF-backed alternative is wired up in a later
# milestone). Still entirely behind RESOSTAGE_ENABLE_CEF so builds that opt
# out are completely unaffected, and behind the user's persisted engine
# choice at runtime (see CefLifecycle.h) even when compiled in.
# ---------------------------------------------------------------------------
if(RESOSTAGE_ENABLE_CEF)
  target_sources(ResoStage PRIVATE cef/CefLifecycle.cpp)
  target_compile_definitions(ResoStage PRIVATE RESOSTAGE_ENABLE_CEF=1)

  include(${CMAKE_SOURCE_DIR}/cmake/CefBundle.cmake)

  function(resostage_add_cef_helper target_suffix bundle_suffix)
    set(helper_target "ResoStageCefHelper${target_suffix}")
    set(helper_name "ResoStage Helper${bundle_suffix}")

    add_executable(${helper_target} MACOSX_BUNDLE cef/HelperMain.mm)
    set_target_properties(${helper_target} PROPERTIES
      OUTPUT_NAME "${helper_name}"
      MACOSX_BUNDLE TRUE
      MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/cef/HelperInfo.plist.in"
      MACOSX_BUNDLE_BUNDLE_NAME "${helper_name}"
      MACOSX_BUNDLE_GUI_IDENTIFIER "com.resonaura.resostage.helper${target_suffix}"
    )
    target_link_libraries(${helper_target} PRIVATE resostage_cef)
    target_compile_features(${helper_target} PRIVATE cxx_std_20)

    resostage_copy_cef_helper(ResoStage ${helper_target})
  endfunction()

  # Four canonical variants -- see app/cef/HelperMain.mm's doc comment for
  # why a single generically-named helper isn't enough.
  resostage_add_cef_helper("" "")
  resostage_add_cef_helper("Gpu" " (GPU)")
  resostage_add_cef_helper("Renderer" " (Renderer)")
  resostage_add_cef_helper("Plugin" " (Plugin)")

  resostage_copy_cef_framework(ResoStage)
  target_link_libraries(ResoStage PRIVATE resostage_cef)
endif()
