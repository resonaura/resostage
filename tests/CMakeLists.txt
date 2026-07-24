add_executable(resoset_engine_tests
  test_main.cpp
  test_master_clock.cpp
  test_routing_engine.cpp
  test_metering.cpp
)

target_link_libraries(resoset_engine_tests PRIVATE resoset_engine doctest)
target_compile_features(resoset_engine_tests PRIVATE cxx_std_20)

add_test(NAME resoset_engine_tests COMMAND resoset_engine_tests)
