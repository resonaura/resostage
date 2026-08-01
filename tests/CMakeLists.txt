add_executable(resostage_engine_tests
  test_main.cpp
  test_master_clock.cpp
  test_routing_engine.cpp
  test_metering.cpp
  test_wav_stream_decoder.cpp
  test_wav_metadata.cpp
  test_audio_ring_buffer.cpp
  test_streaming_track_buffer.cpp
  test_streaming_engine.cpp
  test_project_loader.cpp
  test_project_history.cpp
  test_click_generator.cpp
  test_system_health.cpp
  test_peak_overview.cpp
  test_peak_cache.cpp
  test_artnet_packet.cpp
  test_seqlock.cpp
  test_audio_folder_import.cpp
  test_bar_seek.cpp
)

target_link_libraries(resostage_engine_tests PRIVATE resostage_engine doctest)
target_compile_features(resostage_engine_tests PRIVATE cxx_std_20)

add_test(NAME resostage_engine_tests COMMAND resostage_engine_tests)
