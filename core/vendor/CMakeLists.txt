# Vendored single-file / small dependencies, wired as tiny INTERFACE/static targets.
# SYSTEM includes so juce_recommended_warning_flags (-Wsign-conversion etc.)
# don't fire on third-party headers we don't control.

# ---------------------------------------------------------------------------
# moodycamel::ReaderWriterQueue (header-only SPSC queue)
# ---------------------------------------------------------------------------
add_library(moodycamel_rwq INTERFACE)
target_include_directories(moodycamel_rwq SYSTEM INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/moodycamel)

# ---------------------------------------------------------------------------
# doctest (header-only test framework)
# ---------------------------------------------------------------------------
add_library(doctest INTERFACE)
target_include_directories(doctest SYSTEM INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/doctest)

# ---------------------------------------------------------------------------
# miniz (zip reading)
# ---------------------------------------------------------------------------
add_library(miniz STATIC
  ${CMAKE_CURRENT_SOURCE_DIR}/miniz/miniz.c
  ${CMAKE_CURRENT_SOURCE_DIR}/miniz/miniz_tdef.c
  ${CMAKE_CURRENT_SOURCE_DIR}/miniz/miniz_tinfl.c
  ${CMAKE_CURRENT_SOURCE_DIR}/miniz/miniz_zip.c
)
target_include_directories(miniz SYSTEM PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/miniz)
