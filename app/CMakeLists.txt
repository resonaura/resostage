juce_add_gui_app(ResoStage
  PRODUCT_NAME "ResoStage"
  COMPANY_NAME "Resoset"
  BUNDLE_ID "com.resoset.resostage"
)

target_sources(ResoStage PRIVATE
  Main.cpp
  MainComponent.cpp
  MainComponentBuilder.cpp
  MainComponentSettings.cpp
  MainComponentTimeline.cpp
  AudioEngine.cpp
  midi/CoreMidiDispatcher.cpp
  midi/CoreMidiInputListener.cpp
  events/EventDispatcher.cpp
  platform/AudioWorkgroup.cpp
  platform/ProcessPriority.cpp
  web/WebServer.cpp
  ui/legacy/PlayerPanel.cpp
  ui/legacy/MixerPanel.cpp
  ui/legacy/BuilderPanel.cpp
  ui/legacy/SettingsPanel.cpp
  ui/legacy/TimelineView.cpp
)

if(APPLE)
  target_sources(ResoStage PRIVATE platform/MacTouchBar.mm)
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
    resoset_engine
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
  )
endif()

target_compile_features(ResoStage PRIVATE cxx_std_20)
