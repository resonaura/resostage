/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "AudioEngine.h"

#include "plugins/PluginPaths.h"
#include "plugins/PluginHostProtocol.h"
#include "plugins/PluginRetryScope.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <limits>

namespace resostage {

void AudioEngine::startPluginBankBuilder() {
    pluginBankThread = std::thread([this] { runPluginBankBuilder(); });
}

void AudioEngine::stopPluginBankBuilder() {
    pluginBankGeneration.fetch_add(1, std::memory_order_acq_rel);
    {
        std::lock_guard lock(pluginBankMutex);
        stopPluginBankWorker = true;
        pendingPluginBankBuild.reset();
    }
    pluginBankWake.notify_one();
    if (pluginBankThread.joinable())
        pluginBankThread.join();

    // removeAudioCallback() has completed before this method is called, so
    // releasing every remaining vendor instance here cannot happen on the
    // realtime thread.
    std::atomic_store_explicit(
        &activePluginBank, std::shared_ptr<const PublishedPluginBank>{},
        std::memory_order_release);
    currentPluginLatencySamples.store(0, std::memory_order_relaxed);
    retiredPluginBanks.clear();
}

void AudioEngine::beginProjectMutation() {
    // The callback touches meters even on its stopped early-return path,
    // before routingMutex. A sequentially consistent entry counter and flag
    // make it impossible for an old callback to go uncounted while we replace
    // ProjectLoader and callback-owned vectors. New callbacks emit silence.
    projectTransitioning.store(true);
    while (audioCallbacksInFlight.load() != 0)
        std::this_thread::yield();
    songActivityDirty = true;
}

void AudioEngine::beginProjectReplacement() {
    beginProjectMutation();
    activeManualAutomationLanes.clear();
    manualAutomationLaneSnapshot.reset();
    {
        std::lock_guard lock(pluginBankMutex);
        projectEpoch.fetch_add(1, std::memory_order_acq_rel);
        pluginLoadingSession.replaceProject(projectEpoch.load(std::memory_order_acquire));
        pluginBankGeneration.fetch_add(1, std::memory_order_acq_rel);
        pendingPluginBankBuild.reset();
        recoveredPluginHostKeys.clear();
        currentPluginLatencySamples.store(0, std::memory_order_relaxed);
    }
}

void AudioEngine::endProjectReplacement() {
    // Call only after a matching graph has been published (or a failed load
    // has left the old graph invalid by epoch). No callback can then pair an
    // old graph with the new mutable project.
    projectTransitioning.store(false, std::memory_order_release);
}

void AudioEngine::schedulePluginBankRebuild(bool forceRecreate,
                                            bool recoverFailedHosts,
                                            std::string retryOnlyStripId) {
    if (!projectLoaded)
        return;

    std::shared_ptr<const MixGraph> graph;
    {
        std::lock_guard<std::recursive_mutex> routeLock(routingMutex);
        graph = publishedGraph;
    }
    if (graph == nullptr)
        return;

    PluginBankBuildRequest request;
    request.generation = pluginBankGeneration.fetch_add(
                             1, std::memory_order_acq_rel)
                         + 1;
    request.projectEpoch = projectEpoch.load(std::memory_order_acquire);
    request.project = loader.project();
    request.graph = std::move(graph);
    request.archivePath = loader.archivePath();
    request.sampleRate = currentSampleRate;
    request.maximumBlockSize =
        std::max({currentBlockSize, 512, mixRenderer.maxBlockSize()});
    request.pipelineLatencySamples = static_cast<int>(std::min<int64_t>(
        std::numeric_limits<int>::max(),
        static_cast<int64_t>(std::max(1, currentBlockSize))
            * plugin_host::kAudioPipelineCallbacks));
    request.forceRecreate = forceRecreate;
    request.recoverFailedHosts = recoverFailedHosts;
    request.retryOnlyStripId = std::move(retryOnlyStripId);

    uint32_t slotTotal = 0;
    const auto includeSlots = [&](const std::string& stripId,
                                  const std::vector<PluginSlot>& slots) {
        if (pluginRetryIncludesStrip(request.retryOnlyStripId, stripId))
            slotTotal += static_cast<uint32_t>(slots.size());
    };
    includeSlots("audio::main", request.project.main.plugins);
    includeSlots("audio::click", request.project.click.plugins);
    for (const auto& track : request.project.tracks)
        includeSlots(track.id, track.plugins);
    for (const auto& send : request.project.sends)
        includeSlots(send.id, send.plugins);
    if (!request.retryOnlyStripId.empty() && slotTotal == 0)
        return;
    pluginLoadingSession.begin(request.projectEpoch, request.generation, slotTotal);

    {
        std::lock_guard lock(pluginBankMutex);
        if (stopPluginBankWorker)
            return;
        pendingPluginBankBuild = std::move(request);
    }
    pluginBankWake.notify_one();
}

void AudioEngine::notifyPluginChainsChanged() {
    markDirty();
    publishRoutingSnapshot();
}

void AudioEngine::servicePluginHostChanges() {
    routing.reclaim();
    const auto publication = std::atomic_load_explicit(
        &activePluginBank, std::memory_order_acquire);
    if (publication != nullptr
        && publication->projectEpoch == projectEpoch.load(std::memory_order_acquire)
        && publication->bank != nullptr) {
        if (publication->bank->consumeStateChange())
            markDirty();
        if (publication->bank->consumeLatencyChange())
            schedulePluginBankRebuild();
        const auto loading = pluginLoadingSession.snapshot();
        const bool bankBuildInFlight = loading.epoch == publication->projectEpoch
            && loading.phase == "loading";
        if (!bankBuildInFlight) {
            for (const auto& stripId : publication->bank->failedHostStripIds()) {
                const std::string key = std::to_string(publication->projectEpoch)
                    + ":" + stripId;
                if (recoveredPluginHostKeys.insert(key).second) {
                    schedulePluginBankRebuild(false, true, stripId);
                    // The builder mailbox is latest-wins. Let one automatic
                    // recovery publish before scheduling another failed chain.
                    break;
                }
            }
        }
    }
    if (pluginLoadingSession.takePlayIntent()) play();
}

PluginLoadingSnapshot AudioEngine::pluginLoadingSnapshot() const {
    return projectLoaded ? pluginLoadingSession.snapshot() : PluginLoadingSnapshot{};
}

bool AudioEngine::decidePluginLoading(uint64_t epoch, uint64_t generation,
                                      const std::string& decision) {
    const auto state = pluginLoadingSession.snapshot();
    if (state.epoch != epoch || state.generation != generation) return false;
    if (decision == "retry") {
        if (state.phase == "loading") return false;
        schedulePluginBankRebuild(false, true);
        return true;
    }
    if (decision != "continue" && decision != "stop") return false;
    return pluginLoadingSession.decide(epoch, generation, decision == "continue");
}

std::shared_ptr<PluginProcessorBank> AudioEngine::activePluginProcessorBank() const {
    const auto publication = std::atomic_load_explicit(
        &activePluginBank, std::memory_order_acquire);
    return publication != nullptr
               && publication->projectEpoch == projectEpoch.load(std::memory_order_acquire)
        ? publication->bank : nullptr;
}

bool AudioEngine::hasCurrentPluginProcessorBank() const noexcept {
    const auto publication = std::atomic_load_explicit(
        &activePluginBank, std::memory_order_acquire);
    return publication != nullptr && publication->bank != nullptr
        && publication->projectEpoch == projectEpoch.load(std::memory_order_acquire)
        && publication->processorLayoutKey
            == currentProcessorLayoutKey.load(std::memory_order_acquire);
}

bool AudioEngine::retryPluginSlot(const std::string& slotId,
                                  const std::string& stripId) {
    if (!projectLoaded)
        return false;
    const Project& project = loader.project();
    const std::vector<PluginSlot>* slots = nullptr;
    if (stripId == "audio::main") slots = &project.main.plugins;
    else if (stripId == "audio::click") slots = &project.click.plugins;
    else if (const auto track = std::find_if(project.tracks.begin(), project.tracks.end(),
                 [&](const TrackDef& candidate) { return candidate.id == stripId; });
             track != project.tracks.end()) slots = &track->plugins;
    else if (const auto send = std::find_if(project.sends.begin(), project.sends.end(),
                 [&](const SendBus& candidate) { return candidate.id == stripId; });
             send != project.sends.end()) slots = &send->plugins;
    if (slots == nullptr || std::none_of(slots->begin(), slots->end(),
            [&](const PluginSlot& slot) { return slot.id == slotId; }))
        return false;

    const auto bank = activePluginProcessorBank();
    if (bank != nullptr
        && bank->getStripSlotLoadState(stripId, slotId) == "loaded")
        return false;
    // When the published bank matches the project layout, rebuild only the
    // containing isolated strip chain. A stale/missing bank requires a full
    // reconcile so the new chain cannot publish against a different layout.
    const auto publication = std::atomic_load_explicit(
        &activePluginBank, std::memory_order_acquire);
    const int compatibleBlockSize = std::max(
        {currentBlockSize, 512, mixRenderer.maxBlockSize()});
    const int compatiblePipelineLatency = static_cast<int>(std::min<int64_t>(
        std::numeric_limits<int>::max(),
        static_cast<int64_t>(std::max(1, currentBlockSize))
            * plugin_host::kAudioPipelineCallbacks));
    const bool canScopeRetry = publication != nullptr
        && publication->projectEpoch == projectEpoch.load(std::memory_order_acquire)
        && publication->bank != nullptr
        && publication->processorLayoutKey
            == currentProcessorLayoutKey.load(std::memory_order_acquire)
        && std::abs(publication->sampleRate - currentSampleRate) < 1.0e-6
        && publication->maximumBlockSize == compatibleBlockSize
        && publication->pipelineLatencySamples == compatiblePipelineLatency;
    const std::string retryScope = canScopeRetry ? stripId : std::string{};
    schedulePluginBankRebuild(false, true, retryScope);
    return true;
}

void AudioEngine::setPluginSlotBypassed(const std::string& slotId,
                                        bool bypassed) {
    if (auto bank = activePluginProcessorBank())
        bank->setSlotBypassed(slotId, bypassed);
    // Supersede any chain build that may have captured the previous value.
    // The stable slot IDs are reconciled by the worker, so this publication
    // reuses existing processor instances rather than reloading them.
    schedulePluginBankRebuild();
}

void AudioEngine::runPluginBankBuilder() {
    for (;;) {
        PluginBankBuildRequest request;
        try {
        {
            std::unique_lock lock(pluginBankMutex);
            pluginBankWake.wait(lock, [this] {
                return stopPluginBankWorker || pendingPluginBankBuild.has_value();
            });
            if (stopPluginBankWorker)
                return;
            request = std::move(*pendingPluginBankBuild);
            pendingPluginBankBuild.reset();
        }

        // A document switch can invalidate a request before this worker even
        // starts opening its resource archive. Do not instantiate stale vendor
        // processors just to discard the result at publication time.
        if (request.generation
                != pluginBankGeneration.load(std::memory_order_acquire)
            || request.projectEpoch
                != projectEpoch.load(std::memory_order_acquire))
            continue;

        ProjectLoader resourceLoader;
        const ProjectLoader* resources = nullptr;
        std::string openError;
        if (!request.archivePath.empty()
            && resourceLoader.open(request.archivePath, openError)) {
            resources = &resourceLoader;
        }

        if (request.generation
                != pluginBankGeneration.load(std::memory_order_acquire)
            || request.projectEpoch
                != projectEpoch.load(std::memory_order_acquire))
            continue;

        PluginProcessorBank::BuildResult result;
        const auto current = std::atomic_load_explicit(
            &activePluginBank, std::memory_order_acquire);
        const bool canReuseProcessors = !request.forceRecreate
            && !request.recoverFailedHosts
            && request.retryOnlyStripId.empty() && current != nullptr
            && current->projectEpoch == request.projectEpoch
            && current->bank != nullptr
            && current->processorLayoutKey
                   == request.graph->processorLayoutKey
            && std::abs(current->sampleRate - request.sampleRate) < 1.0e-6
            && current->maximumBlockSize == request.maximumBlockSize
            && current->pipelineLatencySamples == request.pipelineLatencySamples;
        if (canReuseProcessors) {
            result.bank = current->bank;
            const auto currentLatencies =
                result.bank->snapshotStripLatencies();
            const PluginDelayBank* previousDelay =
                (current->routingLayoutKey == request.graph->routingLayoutKey)
                    ? current->delayBank.get() : nullptr;
            result.delayBank = PluginDelayBank::build(
                *request.graph, currentLatencies,
                request.sampleRate, result.warnings,
                previousDelay);
        } else {
            std::vector<PluginProcessorBank::StateBlob> transientStates;
            std::vector<std::string> stateSnapshotWarnings;
            const bool preserveLiveState = request.forceRecreate
                || request.recoverFailedHosts;
            if (preserveLiveState && current != nullptr
                && current->projectEpoch == request.projectEpoch
                && current->bank != nullptr) {
                auto snapshot = current->bank->snapshotStates(
                    request.retryOnlyStripId);
                transientStates = std::move(snapshot.blobs);
                stateSnapshotWarnings = std::move(snapshot.warnings);
            }
            const PluginDelayBank* previousDelay =
                (current != nullptr && current->projectEpoch == request.projectEpoch
                 && current->routingLayoutKey == request.graph->routingLayoutKey)
                    ? current->delayBank.get() : nullptr;
            result = PluginProcessorBank::build(
                request.project, *request.graph, resources,
                pluginRegistryFile(), request.sampleRate,
                request.maximumBlockSize, /*nonRealtime=*/false,
                request.forceRecreate || current == nullptr
                    || current->projectEpoch != request.projectEpoch
                    ? nullptr : current->bank.get(),
                preserveLiveState ? &transientStates : nullptr,
                PluginProcessorBank::ExecutionMode::IsolatedProcess,
                request.pipelineLatencySamples,
                [this, epoch = request.projectEpoch, generation = request.generation]
                    (uint32_t completed, const std::string& name) {
                    pluginLoadingSession.progress(epoch, generation, completed, name);
                },
                [this, epoch = request.projectEpoch, generation = request.generation] {
                    return epoch != projectEpoch.load(std::memory_order_acquire)
                        || generation != pluginBankGeneration.load(std::memory_order_acquire);
                },
                previousDelay, request.retryOnlyStripId);
            for (const auto& warning : stateSnapshotWarnings)
                std::fprintf(stderr, "[PluginBank] Live state snapshot: %s\n",
                    warning.c_str());
        }

        for (const auto& warning : result.warnings) {
            std::fprintf(stderr, "[PluginBank] %s\n", warning.c_str());
        }

        auto publication = std::make_shared<PublishedPluginBank>();
        publication->processorLayoutKey = request.graph->processorLayoutKey;
        publication->routingLayoutKey = request.graph->routingLayoutKey;
        publication->projectEpoch = request.projectEpoch;
        publication->latencyLayoutKey = request.graph->latencyLayoutKey;
        publication->sampleRate = request.sampleRate;
        publication->maximumBlockSize = request.maximumBlockSize;
        publication->pipelineLatencySamples = request.pipelineLatencySamples;
        publication->bank = std::move(result.bank);
        publication->delayBank = std::move(result.delayBank);
        const int publishedLatencySamples = publication->delayBank != nullptr
            ? publication->delayBank->latencySamples()
            : (publication->bank != nullptr
                   ? publication->bank->latencySamples() : 0);

        uint32_t failedSlots = 0;
        const auto inspectSlots = [&](const std::string& stripId,
                                      const std::vector<PluginSlot>& slots) {
            if (!pluginRetryIncludesStrip(request.retryOnlyStripId, stripId))
                return;
            for (const auto& slot : slots) {
                if (publication->bank == nullptr
                    || publication->bank->getStripSlotLoadState(stripId, slot.id)
                        != "loaded")
                    ++failedSlots;
            }
        };
        inspectSlots("audio::main", request.project.main.plugins);
        inspectSlots("audio::click", request.project.click.plugins);
        for (const auto& track : request.project.tracks)
            inspectSlots(track.id, track.plugins);
        for (const auto& send : request.project.sends)
            inspectSlots(send.id, send.plugins);

        {
            std::lock_guard lock(pluginBankMutex);
            // Check and exchange under the same mutex used by document
            // replacement. A late old build cannot restore stale latency
            // after beginProjectReplacement() has set it to zero.
            if (request.generation
                    != pluginBankGeneration.load(std::memory_order_acquire)
                || request.projectEpoch
                    != projectEpoch.load(std::memory_order_acquire))
                continue;
            std::shared_ptr<const PublishedPluginBank> immutablePublication =
                std::move(publication);
            auto previous = std::atomic_exchange_explicit(
                &activePluginBank, std::move(immutablePublication),
                std::memory_order_acq_rel);
            currentPluginLatencySamples.store(
                publishedLatencySamples, std::memory_order_relaxed);
            if (previous != nullptr)
                retiredPluginBanks.push_back(std::move(previous));
            pluginLoadingSession.finish(request.projectEpoch, request.generation,
                failedSlots, result.warnings.empty() ? std::string{} : result.warnings.front());
        }
        // Only this worker mutates the retired list. Prune and run vendor
        // destructors after dropping the control mutex; the callback pins any
        // bank it is still using, so its last reference never dies on audio.
        std::erase_if(retiredPluginBanks, [](const auto& retired) {
            return retired.use_count() == 1;
        });
        } catch (const std::exception& error) {
            pluginLoadingSession.finish(request.projectEpoch, request.generation, 0, error.what());
            std::fprintf(stderr, "[PluginBank] Build failed: %s\n", error.what());
            // Preserve the last publication. The callback validates its
            // project, strip layout, rate and block capacity before use, so a
            // failed replacement cannot make an incompatible bank audible;
            // a compatible previous bank is preferable to an avoidable gap.
        } catch (...) {
            pluginLoadingSession.finish(request.projectEpoch, request.generation, 0,
                "Unknown plug-in bank build failure");
            std::fprintf(stderr, "[PluginBank] Build failed with unknown exception\n");
            // See the typed-exception path above: callback compatibility
            // checks are the fail-closed boundary, not clearing a usable bank.
        }
    }
}

} // namespace resostage
