#include "AudioEngine.h"

#include "plugins/PluginPaths.h"

#include <algorithm>
#include <cmath>

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
    retiredPluginBanks.clear();
}

void AudioEngine::schedulePluginBankRebuild() {
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
    request.project = loader.project();
    request.graph = std::move(graph);
    request.archivePath = loader.archivePath();
    request.sampleRate = currentSampleRate;
    request.maximumBlockSize = std::max(1, currentBlockSize);

    {
        std::lock_guard lock(pluginBankMutex);
        if (stopPluginBankWorker)
            return;
        pendingPluginBankBuild = std::move(request);
    }
    pluginBankWake.notify_one();
}

void AudioEngine::notifyPluginChainsChanged() {
    publishRoutingSnapshot();
    schedulePluginBankRebuild();
}

void AudioEngine::runPluginBankBuilder() {
    for (;;) {
        PluginBankBuildRequest request;
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

        ProjectLoader resourceLoader;
        const ProjectLoader* resources = nullptr;
        std::string openError;
        if (!request.archivePath.empty()
            && resourceLoader.open(request.archivePath, openError)) {
            resources = &resourceLoader;
        }

        auto result = PluginProcessorBank::build(
            request.project, *request.graph, resources, pluginRegistryFile(),
            request.sampleRate, request.maximumBlockSize,
            /*nonRealtime=*/false);

        // A newer chain/device request arrived while vendor code was being
        // constructed. Discard this result on the worker, never publish it.
        if (request.generation
            != pluginBankGeneration.load(std::memory_order_acquire)) {
            continue;
        }

        auto publication = std::make_shared<PublishedPluginBank>();
        publication->processorLayoutKey = request.graph->processorLayoutKey;
        publication->sampleRate = request.sampleRate;
        publication->maximumBlockSize = request.maximumBlockSize;
        publication->bank = std::move(result.bank);

        std::shared_ptr<const PublishedPluginBank> immutablePublication =
            std::move(publication);
        auto previous = std::atomic_exchange_explicit(
            &activePluginBank, std::move(immutablePublication),
            std::memory_order_acq_rel);
        {
            std::lock_guard lock(pluginBankMutex);
            if (previous != nullptr)
                retiredPluginBanks.push_back(std::move(previous));
            std::erase_if(retiredPluginBanks, [](const auto& retired) {
                return retired.use_count() == 1;
            });
        }
    }
}

} // namespace resostage
