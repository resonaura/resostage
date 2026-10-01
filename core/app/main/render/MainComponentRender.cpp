/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// Offline-render orchestration and its isolated processor-session adapter.
// The extraction preserves the existing message-thread setup and worker
// boundaries. Non-WAV encoding consumes a completed private float WAV on the
// same background worker; live transport and device processing stay separate.

#include "MainComponent.h"
#include "engine/AudioEngineInternal.h"
#include "media/FFmpegProcess.h"
#include "plugins/PluginPaths.h"
#include "plugins/PluginProcessorBank.h"
#include "project/ProjectJson.h"
#include "project/Uuid.h"
#include "server/BuilderJson.h"

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <optional>
#include <vector>

#if JUCE_WINDOWS
#include <windows.h>
#elif JUCE_LINUX
#include <fcntl.h>
#include <sys/syscall.h>
#include <unistd.h>
#endif

namespace resostage {

namespace {
bool publishEncodedFile(const std::string& partial, const std::string& destination,
                        std::error_code& error) {
    // Exclusive rename works on ordinary/removable filesystems without
    // hard-link support, and prevents a racing export from overwriting data.
#if JUCE_MAC
    if (renamex_np(partial.c_str(), destination.c_str(), RENAME_EXCL) == 0) {
        error.clear();
        return true;
    }
    error = std::error_code(errno, std::generic_category());
#elif JUCE_WINDOWS
    const std::filesystem::path sourcePath(std::u8string(partial.begin(), partial.end()));
    const std::filesystem::path destinationPath(std::u8string(destination.begin(), destination.end()));
    if (MoveFileExW(sourcePath.c_str(), destinationPath.c_str(), MOVEFILE_WRITE_THROUGH) != 0) {
        error.clear();
        return true;
    }
    error = std::error_code(static_cast<int>(GetLastError()), std::system_category());
#elif JUCE_LINUX && defined(SYS_renameat2)
    constexpr unsigned kRenameNoReplace = 1;
    if (syscall(SYS_renameat2, AT_FDCWD, partial.c_str(), AT_FDCWD,
                destination.c_str(), kRenameNoReplace) == 0) {
        error.clear();
        return true;
    }
    error = std::error_code(errno, std::generic_category());
#else
    std::filesystem::create_hard_link(partial, destination, error);
    if (!error) {
        std::filesystem::remove(partial, error);
        error.clear();
        return true;
    }
#endif
    return false;
}

class OfflinePluginSession final : public OfflineProcessorSession {
public:
    OfflinePluginSession(std::shared_ptr<PluginProcessorBank> bankIn,
                         std::shared_ptr<PluginDelayBank> delayBankIn,
                         std::vector<std::string> warningsIn)
        : bank(std::move(bankIn)), delayBank(std::move(delayBankIn)),
          buildWarnings(std::move(warningsIn)) {}

    MixProcessorView processorView() const noexcept override {
        return bank != nullptr
            ? bank->processorView(delayBank.get()) : MixProcessorView{};
    }

    void publishTransport(
        const OfflineProcessorTransport& transport) noexcept override {
        if (bank == nullptr)
            return;
        PluginTransportState state;
        state.sample = transport.sample;
        state.sampleRate = transport.sampleRate;
        state.bpm = transport.bpm;
        state.numerator = transport.numerator;
        state.denominator = transport.denominator;
        state.playing = transport.playing;
        state.looping = transport.looping;
        state.loopStartSample = transport.loopStartSample;
        state.loopEndSample = transport.loopEndSample;
        bank->publishTransport(state);
    }

    bool stripHasInstrument(uint32_t strip) const noexcept override {
        return bank != nullptr && bank->stripHasInstrument(strip);
    }

    void queueMidiNote(uint32_t strip, uint8_t channel, uint8_t pitch, uint8_t velocity,
                       uint8_t releaseVelocity, bool noteOn,
                       int samplePosition) noexcept override {
        if (bank == nullptr || !bank->stripHasInstrument(strip))
            return;
        const auto message = noteOn
            ? juce::MidiMessage::noteOn(static_cast<int>(channel) + 1, pitch, velocity)
            : juce::MidiMessage::noteOff(static_cast<int>(channel) + 1, pitch, releaseVelocity);
        bank->addStripMidiEvent(strip, message, samplePosition);
    }

    void queueMidiMessage(uint32_t strip, uint8_t status, uint8_t data1,
                          uint8_t data2, uint8_t dataLength,
                          int samplePosition) noexcept override {
        if (bank == nullptr || !bank->stripHasInstrument(strip) || dataLength > 2)
            return;
        uint8_t bytes[3] = { status, data1, data2 };
        const int length = static_cast<int>(dataLength) + 1;
        bank->addStripMidiEvent(strip, juce::MidiMessage(bytes, length), samplePosition);
    }

    void setPluginParameter(const std::string& slotId, int parameterIndex,
                            float normalizedValue) noexcept override {
        if (bank == nullptr || slotId.empty())
            return;
        // This session is private to the offline render worker. Unlike live
        // automation, this write never races the device callback or UI host.
        (void)bank->setPluginParameterBySlotId(
            slotId, parameterIndex, normalizedValue);
    }

    double declaredTailSeconds() const noexcept override {
        return bank != nullptr ? bank->tailSeconds() : 0.0;
    }

    std::vector<std::string> warnings() const override {
        return buildWarnings;
    }

private:
    std::shared_ptr<PluginProcessorBank> bank;
    std::shared_ptr<PluginDelayBank> delayBank;
    std::vector<std::string> buildWarnings;
};
} // namespace

void MainComponent::startAudioRender(const std::string& json) {
    if (audioRenderRunning.exchange(true, std::memory_order_acq_rel)) {
        webServer.failAudioRender("Another audio render is already running");
        return;
    }
    if (audioRenderThread.joinable())
        audioRenderThread.join();

    OfflineRenderRequest request;
    glz::generic doc;
    if (!builder_json::parseJson(json, doc)) {
        audioRenderRunning.store(false, std::memory_order_release);
        webServer.failAudioRender("Invalid render options");
        return;
    }

    std::string scope = "song";
    std::string legacyTarget = "master";
    std::string legacyTargetId;
    std::string namingPattern = "{project}_{song}_{stem}";
    std::string tailPolicy = "cut";
    std::string dither = "none";
    std::string outputFormat = "wav";
    std::string normalization = "off";
    int songIndex = static_cast<int>(engine.currentSongIndex());
    int sampleRate = static_cast<int>(std::lround(std::max(8000.0, engine.project().sampleRate)));
    int bitDepth = 24;
    double rangeStart = 0.0;
    double rangeEnd = 0.0;
    double tailThresholdDb = -96.0;
    double tailQuietSeconds = 0.5;
    double maxTailSeconds = 30.0;
    double normalizationCeilingDb = -0.1;
    bool trimOutputLatency = true;
    (void)builder_json::getString(doc, "scope", scope);
    (void)builder_json::getString(doc, "target", legacyTarget);
    (void)builder_json::getString(doc, "targetId", legacyTargetId);
    if (!builder_json::getString(doc, "fileNamePattern", namingPattern))
        (void)builder_json::getString(doc, "fileName", namingPattern);
    (void)builder_json::getString(doc, "tailPolicy", tailPolicy);
    (void)builder_json::getString(doc, "dither", dither);
    (void)builder_json::getString(doc, "outputFormat", outputFormat);
    (void)builder_json::getString(doc, "normalization", normalization);
    (void)builder_json::getInt(doc, "songIndex", songIndex);
    (void)builder_json::getInt(doc, "sampleRate", sampleRate);
    (void)builder_json::getInt(doc, "bitDepth", bitDepth);
    (void)builder_json::getDouble(doc, "rangeStartSeconds", rangeStart);
    (void)builder_json::getDouble(doc, "rangeEndSeconds", rangeEnd);
    (void)builder_json::getDouble(doc, "tailThresholdDb", tailThresholdDb);
    (void)builder_json::getDouble(doc, "tailQuietSeconds", tailQuietSeconds);
    (void)builder_json::getDouble(doc, "maxTailSeconds", maxTailSeconds);
    (void)builder_json::getDouble(doc, "normalizationCeilingDb", normalizationCeilingDb);
    (void)builder_json::getBool(doc, "trimOutputLatency", trimOutputLatency);

    if (outputFormat != "wav" && outputFormat != "aiff" && outputFormat != "flac"
        && outputFormat != "mp3" && outputFormat != "m4a" && outputFormat != "alac"
        && outputFormat != "opus" && outputFormat != "ogg" && outputFormat != "wma") {
        audioRenderRunning.store(false, std::memory_order_release);
        webServer.failAudioRender("Unsupported audio export format");
        return;
    }

    request.songIndex = scope == "project" ? -1 : songIndex;
    request.sampleRate = sampleRate;
    request.bitDepth = bitDepth;
    request.rangeStartSeconds = std::max(0.0, rangeStart);
    request.rangeEndSeconds = std::max(0.0, rangeEnd);
    request.tailPolicy = tailPolicy == "leave" ? RenderTailPolicy::Leave
        : (tailPolicy == "wrap" ? RenderTailPolicy::Wrap : RenderTailPolicy::Cut);
    request.dither = dither == "tpdf" ? RenderDither::Tpdf : RenderDither::None;
    request.normalization = normalization == "overload" ? RenderNormalization::OverloadProtection
        : (normalization == "peak" ? RenderNormalization::Peak : RenderNormalization::Off);
    request.normalizationCeilingDb = std::clamp(normalizationCeilingDb, -12.0, 0.0);
    request.trimOutputLatency = trimOutputLatency;
    request.tailThresholdDb = std::clamp(tailThresholdDb, -144.0, -24.0);
    request.tailQuietSeconds = std::clamp(tailQuietSeconds, 0.05, 10.0);
    request.maxTailSeconds = std::clamp(maxTailSeconds, 0.0, 60.0);

    auto kindFromWire = [](const std::string& kind) {
        if (kind == "track") return RenderTargetKind::Track;
        if (kind == "bus") return RenderTargetKind::Bus;
        if (kind == "click") return RenderTargetKind::Click;
        return RenderTargetKind::Master;
    };
    if (const auto* targetRows = builder_json::getArray(doc, "targets")) {
        for (const auto& row : *targetRows) {
            if (request.targets.size() >= 256) break;
            std::string kind;
            std::string id;
            if (!builder_json::getString(row, "kind", kind)) continue;
            (void)builder_json::getString(row, "id", id);
            request.targets.push_back({kindFromWire(kind), std::move(id), {}});
        }
    }
    if (request.targets.empty())
        request.targets.push_back({kindFromWire(legacyTarget), legacyTargetId, {}});

    const Project& liveProject = engine.project();
    auto stemName = [&liveProject](const OfflineRenderTarget& target) -> juce::String {
        if (target.kind == RenderTargetKind::Master) return "Main";
        if (target.kind == RenderTargetKind::Click) return "Click";
        if (target.kind == RenderTargetKind::Track) {
            for (const auto& track : liveProject.tracks)
                if (track.id == target.id) return juce::String(track.name);
            return "Track";
        }
        for (const auto& bus : liveProject.sends)
            if (bus.id == target.id) return juce::String(bus.name);
        return "Bus";
    };

    juce::File base(engine.projectPath());
    juce::File exportDir = base.getParentDirectory().getChildFile("Exports");
    if (engine.projectPath().empty())
        exportDir = juce::File::getSpecialLocation(juce::File::userDocumentsDirectory)
                        .getChildFile("ResoStage Exports");
    exportDir.createDirectory();

    const juce::String projectToken = juce::String(liveProject.name).isNotEmpty()
        ? juce::String(liveProject.name) : juce::String("Project");
    juce::String songToken = "Project";
    if (request.songIndex >= 0 && request.songIndex < static_cast<int>(liveProject.songs.size()))
        songToken = juce::String(liveProject.songs[static_cast<size_t>(request.songIndex)].name);
    std::vector<std::string> plannedOutputPaths;
    std::vector<std::string> finalOutputPaths;
    std::vector<std::string> renderStagePaths;
    const juce::String outputExtension = outputFormat == "aiff" ? ".aiff"
        : (outputFormat == "flac" ? ".flac"
        : (outputFormat == "mp3" ? ".mp3"
        : ((outputFormat == "m4a" || outputFormat == "alac") ? ".m4a"
        : (outputFormat == "opus" ? ".opus"
        : (outputFormat == "ogg" ? ".ogg"
        : (outputFormat == "wma" ? ".wma" : ".wav"))))));
    for (auto& target : request.targets) {
        juce::String expanded(namingPattern);
        expanded = expanded.replace("{project}", projectToken)
                           .replace("{song}", songToken)
                           .replace("{stem}", stemName(target))
                           .replace("{sampleRate}", juce::String(request.sampleRate))
                           .replace("{bitDepth}", juce::String(request.bitDepth));
        juce::String safeName = expanded.retainCharacters(
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 _-.()");
        if (safeName.endsWithIgnoreCase(".wav"))
            safeName = safeName.dropLastCharacters(4);
        safeName = safeName.trim();
        if (safeName.isEmpty()) safeName = "ResoStage Render";
        if (safeName.endsWithIgnoreCase(".wav") || safeName.endsWithIgnoreCase(".aiff")
            || safeName.endsWithIgnoreCase(".flac") || safeName.endsWithIgnoreCase(".mp3")
            || safeName.endsWithIgnoreCase(".m4a") || safeName.endsWithIgnoreCase(".opus")
            || safeName.endsWithIgnoreCase(".ogg") || safeName.endsWithIgnoreCase(".wma"))
            safeName = juce::File(safeName).getFileNameWithoutExtension();
        juce::File output = exportDir.getChildFile(safeName + outputExtension);
        int copy = 2;
        while (output.exists()
               || std::find(plannedOutputPaths.begin(), plannedOutputPaths.end(),
                            output.getFullPathName().toStdString()) != plannedOutputPaths.end()) {
            output = exportDir.getChildFile(safeName + " " + juce::String(copy++) + outputExtension);
        }
        const std::string finalPath = output.getFullPathName().toStdString();
        finalOutputPaths.push_back(finalPath);
        plannedOutputPaths.push_back(finalPath);
        if (outputFormat == "wav") {
            target.outputPath = finalPath;
        } else {
            target.outputPath = exportDir.getChildFile(
                ".resostage-render-" + juce::String(generateUuidV7()) + ".wav")
                .getFullPathName().toStdString();
        }
        renderStagePaths.push_back(target.outputPath);
    }
    request.outputPath = request.targets.front().outputPath;
    const int exportBitDepth = request.bitDepth;
    const RenderDither exportDither = request.dither;
    if (outputFormat != "wav") {
        // Keep the intermediate lossless float audio. Integer quantization
        // belongs to the final encoder, not an extra 16/24-bit staging pass.
        request.bitDepth = 32;
        request.dither = RenderDither::None;
    }

    const Project projectSnapshot = engine.project();
    const std::string projectPath = engine.projectPath();
    cancelAudioRender.store(false, std::memory_order_release);
    setStatus("Rendering audio in background…");
    const juce::Component::SafePointer<MainComponent> safeThis(this);
    audioRenderThread = std::thread([this, safeThis, projectSnapshot, projectPath, request,
                                     outputFormat, exportBitDepth, exportDither, finalOutputPaths, renderStagePaths]() mutable {
        OfflineRenderer renderer;
        const OfflineRenderer::ProcessorFactory processorFactory =
            [projectPath](const Project& project, const MixGraph& graph,
                          double renderSampleRate, int maximumBlockSize,
                          std::string& error)
                -> std::unique_ptr<OfflineProcessorSession> {
                ProjectLoader resourceLoader;
                const ProjectLoader* resources = nullptr;
                if (!projectPath.empty()) {
                    std::string openError;
                    if (resourceLoader.open(projectPath, openError))
                        resources = &resourceLoader;
                }
                auto built = PluginProcessorBank::build(
                    project, graph, resources, pluginRegistryFile(), renderSampleRate,
                    maximumBlockSize, /*nonRealtime=*/true);
                if (built.bank == nullptr) {
                    error = "Could not create offline plug-in bank";
                    return nullptr;
                }
                return std::make_unique<OfflinePluginSession>(
                    std::move(built.bank), std::move(built.delayBank),
                    std::move(built.warnings));
            };
        OfflineRenderResult result = renderer.render(
            projectSnapshot, projectPath, request,
            [this, renderSampleRate = request.sampleRate](const OfflineRenderProgress& progress) {
                webServer.updateAudioRenderProgress(
                    progress.progress, progress.processedFrames,
                    progress.estimatedTotalFrames, renderSampleRate, progress.phase);
            },
            &cancelAudioRender, processorFactory);
        if (result.ok && outputFormat != "wav") {
            std::vector<std::string> committedOutputs;
            std::string conversionError;
            for (size_t i = 0; i < result.outputPaths.size(); ++i) {
                const std::string& stagedWav = result.outputPaths[i];
                const std::string& finalPath = finalOutputPaths[i];
                const std::string partialPath = finalPath + ".resostage-part-" + generateUuidV7();
                std::vector<std::string> arguments = {
                    "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-threads", "2",
                    "-i", stagedWav, "-map", "0:a:0", "-vn",
                };
                std::string muxer;
                if (outputFormat == "aiff") {
                    const std::string codec = exportBitDepth == 32 ? "pcm_f32be"
                        : "pcm_s" + std::to_string(exportBitDepth) + "be";
                    arguments.insert(arguments.end(), {"-c:a", codec});
                    muxer = "aiff";
                } else if (outputFormat == "flac") {
                    const int losslessBits = std::min(exportBitDepth, 24);
                    arguments.insert(arguments.end(), {"-c:a", "flac", "-compression_level", "8",
                        "-sample_fmt", losslessBits <= 16 ? "s16" : "s32",
                        "-bits_per_raw_sample", std::to_string(losslessBits)});
                    muxer = "flac";
                } else if (outputFormat == "mp3") {
                    arguments.insert(arguments.end(), {"-c:a", "libmp3lame", "-q:a", "2"});
                    muxer = "mp3";
                } else if (outputFormat == "m4a") {
                    arguments.insert(arguments.end(), {"-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart"});
                    muxer = "ipod";
                } else if (outputFormat == "alac") {
                    const int losslessBits = std::min(exportBitDepth, 24);
                    arguments.insert(arguments.end(), {"-c:a", "alac", "-movflags", "+faststart",
                        "-sample_fmt", losslessBits <= 16 ? "s16p" : "s32p",
                        "-bits_per_raw_sample", std::to_string(losslessBits)});
                    muxer = "ipod";
                } else if (outputFormat == "opus") {
                    arguments.insert(arguments.end(), {"-c:a", "libopus", "-b:a", "160k", "-vbr", "on"});
                    muxer = "opus";
                } else if (outputFormat == "ogg") {
                    arguments.insert(arguments.end(), {"-c:a", "libvorbis", "-q:a", "5"});
                    muxer = "ogg";
                } else if (outputFormat == "wma") {
                    arguments.insert(arguments.end(), {"-c:a", "wmav2", "-b:a", "192k"});
                    muxer = "asf";
                }
                if (exportDither == RenderDither::Tpdf
                    && (outputFormat == "flac" || outputFormat == "alac"
                        || (outputFormat == "aiff" && exportBitDepth != 32))) {
                    const int integerBits = std::min(exportBitDepth, 24);
                    const std::string sampleFormat = integerBits <= 16 ? "s16" : "s32";
                    arguments.insert(arguments.end(), {"-af", "aresample=osf=" + sampleFormat
                        + ":output_sample_bits=" + std::to_string(integerBits)
                        + ":dither_method=triangular"});
                }
                arguments.insert(arguments.end(), {"-threads", "2", "-f", muxer, partialPath});

                const double encodeProgress = 0.99 + 0.005 * (static_cast<double>(i)
                    / static_cast<double>(std::max<size_t>(1, result.outputPaths.size())));
                webServer.updateAudioRenderProgress(encodeProgress, result.framesWritten,
                    result.framesWritten, request.sampleRate, "encoding");
                std::string ffmpegError;
                const bool encoded = media::runFFmpeg(arguments, ffmpegError, &cancelAudioRender);
                std::error_code ec;
                if (!encoded) {
                    std::filesystem::remove(partialPath, ec);
                    conversionError = ffmpegError;
                    break;
                }
                if (cancelAudioRender.load(std::memory_order_acquire)) {
                    std::filesystem::remove(partialPath, ec);
                    conversionError = "Audio render cancelled";
                    break;
                }
                if (!publishEncodedFile(partialPath, finalPath, ec)) {
                    const std::string publishError = ec.message();
                    std::filesystem::remove(partialPath, ec);
                    conversionError = "Could not finalize exported audio without replacing an existing file: " + publishError;
                    break;
                }
                committedOutputs.push_back(finalPath);
                std::filesystem::remove(stagedWav, ec);
            }
            if (!conversionError.empty()) {
                std::error_code ec;
                for (const auto& path : committedOutputs) std::filesystem::remove(path, ec);
                for (const auto& path : renderStagePaths) std::filesystem::remove(path, ec);
                result.ok = false;
                result.error = std::move(conversionError);
            } else {
                result.outputPaths = finalOutputPaths;
                result.outputPath = finalOutputPaths.front();
            }
        }
        if (result.ok)
            webServer.completeAudioRender(result.outputPaths, result.warnings);
        else
            webServer.failAudioRender(result.error);
        audioRenderRunning.store(false, std::memory_order_release);
        juce::MessageManager::callAsync([safeThis, result]() {
            if (safeThis == nullptr) return;
            safeThis->setStatus(result.ok
                ? "Render complete: " + juce::String(result.outputPath)
                : "Render failed: " + juce::String(result.error));
        });
    });
}

} // namespace resostage
