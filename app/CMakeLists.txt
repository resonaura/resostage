juce_add_gui_app(ResoStage
  PRODUCT_NAME "ResoStage"
  COMPANY_NAME "Resoset"
  BUNDLE_ID "com.resoset.resostage"
)

target_sources(ResoStage PRIVATE
  Main.cpp
  MainComponent.cpp
  AudioEngine.cpp
)

target_compile_definitions(ResoStage
  PRIVATE
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:ResoStage,JUCE_PRODUCT_NAME>"
    JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:ResoStage,JUCE_VERSION>"
)

target_link_libraries(ResoStage
  PRIVATE
    resoset_engine
    juce::juce_audio_basics
    juce::juce_audio_devices
    juce::juce_audio_formats
    juce::juce_audio_utils
    juce::juce_core
    juce::juce_data_structures
    juce::juce_events
    juce::juce_graphics
    juce::juce_gui_basics
  PUBLIC
    juce::juce_recommended_config_flags
    juce::juce_recommended_lto_flags
    juce::juce_recommended_warning_flags
)

target_compile_features(ResoStage PRIVATE cxx_std_20)
