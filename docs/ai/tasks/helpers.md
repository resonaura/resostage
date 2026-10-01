# Helper artwork and Windows package layout

## Scope

Use the supplied `icons/helper.{icns,ico,png}` for scanner, plug-in host,
media conversion, and Kaishaku. Keep Core's own artwork. All macOS helpers
must have branded bundles, executable names, versions, descriptions, and icons.

Package Windows Core and its sibling helpers/DLLs under `helpers/`; keep
`resostage.exe` at the package root. Update Electron discovery and development
fallbacks together. Core's existing sibling resolvers must remain valid. Keep
FFmpeg notices beside the media worker. Avoid duplicating helper applications.

## Verification

- Test packaged Windows resolver paths and legacy/development fallbacks.
- Test helper resources and metadata independent of installed user preferences.
- Assemble macOS, inspect helper plists/icons, and verify signatures bottom-up.
- Run native, Electron, and media packaging tests. Windows runtime acceptance
  is separate from cross-platform path tests and must not be implied by them.

Status: implementation and verification in progress.
