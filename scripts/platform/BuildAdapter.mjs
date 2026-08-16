/**
 * Base Abstract Build Platform Adapter for ResoStage Build Pipeline.
 *
 * Mirrors electron/src/platform design pattern to decouple all OS-specific
 * build assembly, icon patching, installer creation, and process management.
 */

export class BuildAdapter {
  /** @abstract Platform key ("mac", "win32", "linux"). */
  get key() {
    throw new Error("BuildAdapter.key must be implemented by subclass");
  }

  /** @abstract Get the raw C++ JUCE core application build location. */
  getRawCoreAppBundle() {
    throw new Error("BuildAdapter.getRawCoreAppBundle() must be implemented by subclass");
  }

  /** @abstract Get the assembled top-level shell app bundle location. */
  getShellAppBundle() {
    throw new Error("BuildAdapter.getShellAppBundle() must be implemented by subclass");
  }

  /** @abstract Get the executable path of the primary shell. */
  shellExecutablePath() {
    throw new Error("BuildAdapter.shellExecutablePath() must be implemented by subclass");
  }

  /** @abstract Check if the application or core backend is currently running. */
  appIsRunning() {
    throw new Error("BuildAdapter.appIsRunning() must be implemented by subclass");
  }

  /** @abstract Stop any running instance of the application. */
  killApp(_opts = {}) {
    throw new Error("BuildAdapter.killApp() must be implemented by subclass");
  }

  /** @abstract Embed web UI into the core bundle (or resources/web). */
  embedWebUi() {
    throw new Error("BuildAdapter.embedWebUi() must be implemented by subclass");
  }

  /** @abstract Assemble the complete application bundle for this OS platform. */
  assembleShellBundle() {
    throw new Error("BuildAdapter.assembleShellBundle() must be implemented by subclass");
  }

  /** @abstract Publish/build installer artifacts for this OS platform. */
  publish() {
    throw new Error("BuildAdapter.publish() must be implemented by subclass");
  }
}
