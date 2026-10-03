/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "AudioEngine.h"

#include "plugins/PluginPaths.h"
#include "plugins/PluginHostProtocol.h"

#include <algorithm>
#include <cmath>
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
                                            bool recoverFailedHosts) {
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

    uint32_t slotTotal = static_cast<uint32_t>(request.project.main.plugins.size()
        + request.project.click.plugins.size());
    for (const auto& track : request.project.tracks)
        slotTotal += static_cast<uint32_t>(track.plugins.size());
    for (const auto& send : request.project.sends)
        slotTotal += static_cast<uint32_t>(send.plugins.size());
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
        for (const auto& stripId : publication->bank->failedHostStripIds()) {
            const std::string key = std::to_string(publication->projectEpoch)
                + ":" + stripId;
            if (recoveredPluginHostKeys.insert(key).second)
                schedulePluginBankRebuild(false, true);
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

bool AudioEngine::retryPluginSlot(const std::string& slotId) {
    const auto bank = activePluginProcessorBank();
    if (bank != nullptr && bank->getSlotLoadState(slotId) == "loaded")
        return false;
    // Restart only the containing isolated chain. The builder reuses every
    // healthy sibling chain and retries slots that reported load failure.
    schedulePluginBankRebuild(false, true);
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
            && !request.recoverFailedHosts && current != nullptr
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
            if (request.forceRecreate && current != nullptr
                && current->projectEpoch == request.projectEpoch
                && current->bank != nullptr)
                transientStates = current->bank->snapshotStates().blobs;
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
                request.forceRecreate ? &transientStates : nullptr,
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
                previousDelay);
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
        const auto inspectSlots = [&](const std::vector<PluginSlot>& slots) {
            for (const auto& slot : slots)
                if (publication->bank == nullptr
                    || publication->bank->getSlotLoadState(slot.id) != "loaded") ++failedSlots;
        };
        inspectSlots(request.project.main.plugins);
        inspectSlots(request.project.click.plugins);
        for (const auto& track : request.project.tracks) inspectSlots(track.plugins);
        for (const auto& send : request.project.sends) inspectSlots(send.plugins);

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
