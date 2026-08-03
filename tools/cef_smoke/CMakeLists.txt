# Standalone CEF spike (see CEF integration milestone M1) -- validates
# framework linking/bundling/subprocess-relaunch mechanics in isolation,
# with no JUCE involved, before any of it gets wired into the real app.

include(${CMAKE_SOURCE_DIR}/cmake/CefBundle.cmake)

add_executable(cef_smoke MACOSX_BUNDLE main.mm)
set_target_properties(cef_smoke PROPERTIES
  MACOSX_BUNDLE TRUE
  MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/Info.plist.in"
  MACOSX_BUNDLE_BUNDLE_NAME "cef_smoke"
  MACOSX_BUNDLE_GUI_IDENTIFIER "com.resonaura.resostage.cefsmoke"
)
target_link_libraries(cef_smoke PRIVATE resostage_cef "-framework Cocoa")
target_compile_features(cef_smoke PRIVATE cxx_std_20)

# CEF's default (browser_subprocess_path left empty) mac subprocess-path
# derivation doesn't just relaunch one generic "<App> Helper.app" for every
# process type -- it looks for distinct, specifically-named helper bundles
# per role (base/GPU/Renderer/Plugin), since each role gets different
# hardened-runtime entitlements in a real (non-smoke-test) build. Confirmed
# empirically: without a "cef_smoke Helper (Renderer).app", CEF fell back to
# relaunching the main cef_smoke executable itself as the renderer process,
# which macOS's AppleSystemPolicy correctly denied (visible as repeated
# "ASP: Security policy would not allow process" log entries) -- gpu-process
# and utility processes happened to still resolve to the plain base Helper,
# but renderer did not. Building all four canonical variants (all sharing
# the same trivial HelperMain.mm -- CEF passes --type= on the command line
# at relaunch time, so the binary itself doesn't need to know its role)
# matches CEF's own convention and fixes this.
function(resostage_add_cef_smoke_helper target_suffix bundle_suffix)
  set(helper_target "cef_smoke_helper${target_suffix}")
  set(helper_name "cef_smoke Helper${bundle_suffix}")

  add_executable(${helper_target} MACOSX_BUNDLE HelperMain.mm)
  set_target_properties(${helper_target} PROPERTIES
    OUTPUT_NAME "${helper_name}"
    MACOSX_BUNDLE TRUE
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/HelperInfo.plist.in"
    MACOSX_BUNDLE_BUNDLE_NAME "${helper_name}"
    MACOSX_BUNDLE_GUI_IDENTIFIER "com.resonaura.resostage.cefsmoke.helper${target_suffix}"
  )
  target_link_libraries(${helper_target} PRIVATE resostage_cef)
  target_compile_features(${helper_target} PRIVATE cxx_std_20)

  resostage_copy_cef_helper(cef_smoke ${helper_target})
endfunction()

resostage_add_cef_smoke_helper("" "")
resostage_add_cef_smoke_helper("_gpu" " (GPU)")
resostage_add_cef_smoke_helper("_renderer" " (Renderer)")
resostage_add_cef_smoke_helper("_plugin" " (Plugin)")

resostage_copy_cef_framework(cef_smoke)
