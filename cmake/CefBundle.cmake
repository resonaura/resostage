# Shared macOS app-bundle assembly helpers for CEF-using targets (the
# tools/cef_smoke spike and, in a later milestone, the real ResoStage app).
#
# Deliberately NOT reusing CEF's own cmake/cef_macros.cmake macros
# (COPY_MAC_FRAMEWORK etc.) directly here: those are defined as CMake
# `macro()`s inside CEF's own CMakeLists.txt, which only runs once, nested
# inside vendor/cef's directory scope during FetchContent_MakeAvailable --
# CMake macro/function definitions only propagate into subdirectories added
# *after* the definition from *within that same scope*, so they are not
# visible from unrelated sibling directories like tools/cef_smoke or app/.
# Re-implementing the (short, stable) copy logic here avoids fragile
# cross-scope include() tricks and keeps it independent of exactly how
# CEF's own build scripts are organized in any given pinned version.
#
# Requires RESOSTAGE_CEF_FRAMEWORK_DIR (a CACHE INTERNAL variable set by
# vendor/cef/CMakeLists.txt, so it's visible globally regardless of scope).

# Copies the CEF framework into `target`'s app bundle using the versioned
# symlink structure macOS/Xcode 26 requires (see the CEF distribution's
# README.txt "REDISTRIBUTION" section) -- a flat, unversioned copy of the
# framework will fail to load on current toolchains.
function(resostage_copy_cef_framework target)
  set(dest "$<TARGET_BUNDLE_CONTENT_DIR:${target}>/Frameworks/Chromium Embedded Framework.framework")
  add_custom_command(
    TARGET ${target}
    POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "${dest}/Versions/A"
    COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${RESOSTAGE_CEF_FRAMEWORK_DIR}"
            "${dest}/Versions/A"
    COMMAND cd "${dest}" && ln -sf "Versions/A/Chromium Embedded Framework" "Chromium Embedded Framework"
    COMMAND cd "${dest}" && ln -sf "Versions/A/Libraries" "Libraries"
    COMMAND cd "${dest}" && ln -sf "Versions/A/Resources" "Resources"
    COMMAND cd "${dest}/Versions" && ln -sf "A" "Current"
    VERBATIM
  )
endfunction()

# Copies a helper .app bundle (already built as its own MACOSX_BUNDLE target)
# into `target`'s Contents/Frameworks/, where CEF's browser process expects
# to find it (see browser_subprocess_path in CefSettings).
function(resostage_copy_cef_helper target helper_target)
  add_custom_command(
    TARGET ${target}
    POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory
            "$<TARGET_BUNDLE_DIR:${helper_target}>"
            "$<TARGET_BUNDLE_CONTENT_DIR:${target}>/Frameworks/$<TARGET_BUNDLE_DIR_NAME:${helper_target}>"
    DEPENDS ${helper_target}
    VERBATIM
  )
  add_dependencies(${target} ${helper_target})
endfunction()
