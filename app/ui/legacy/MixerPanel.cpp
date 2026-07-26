#include "ui/legacy/MixerPanel.h"
#include "ui/legacy/UiColors.h"

#include <algorithm>

namespace resoset {

MixerPanel::MixerPanel(AudioEngine& engineRef) : engine(engineRef) {
    title.setText("MIXER  --  tracks of current song + global busses", juce::dontSendNotification);
    title.setColour(juce::Label::textColourId, ui::muted());
    title.setFont(juce::Font(juce::FontOptions(12.0f, juce::Font::bold)));
    addAndMakeVisible(title);

    emptyLabel.setText("Load a project to open the mixer.", juce::dontSendNotification);
    emptyLabel.setJustificationType(juce::Justification::centred);
    emptyLabel.setColour(juce::Label::textColourId, ui::muted());
    addAndMakeVisible(emptyLabel);

    noTracksHint.setText(
        "No song/tracks staged -- select a song to see its tracks here.\n"
        "Sends and busses below are project-wide and always available.",
        juce::dontSendNotification);
    noTracksHint.setJustificationType(juce::Justification::centredLeft);
    noTracksHint.setColour(juce::Label::textColourId, ui::muted());
    noTracksHint.setFont(juce::Font(juce::FontOptions(12.0f)));
    stripContainer.addChildComponent(noTracksHint);

    viewport.setViewedComponent(&stripContainer, false);
    viewport.setScrollBarsShown(false, true);
    addAndMakeVisible(viewport);

    addReturnBusButton.setColour(juce::TextButton::buttonColourId, ui::panelAlt());
    addReturnBusButton.setColour(juce::TextButton::textColourOffId, ui::text());
    addReturnBusButton.setTooltip("Create a new Return (aux) bus -- adds a send knob for it on every track");
    addReturnBusButton.onClick = [this] { addReturnBusClicked(); };
    addAndMakeVisible(addReturnBusButton);
}

void MixerPanel::addReturnBusClicked() {
    if (!engine.isProjectLoaded())
        return;

    Project& proj = engine.project();
    std::vector<std::string> usedIds;
    usedIds.reserve(proj.busses.size());
    for (const auto& b : proj.busses)
        usedIds.push_back(b.id);
    std::string id;
    for (int n = 1; n < 1000; ++n) {
        std::string candidate = "return_" + std::to_string(n);
        if (std::find(usedIds.begin(), usedIds.end(), candidate) == usedIds.end()) {
            id = candidate;
            break;
        }
    }

    int nextCh = 0;
    for (const auto& b : proj.busses)
        nextCh = std::max(nextCh, b.output.startChannel + b.channels);

    BusDef bus;
    bus.id = id;
    bus.name = "Return " + juce::String(static_cast<int>(proj.busses.size()) + 1).toStdString();
    bus.channels = 2;
    bus.output.startChannel = nextCh;
    bus.isAux = true;
    proj.busses.push_back(std::move(bus));

    // Republish engine-side bus/routing state, then rebuild strips -- every
    // track strip picks up a new send knob for this bus automatically
    // (rebuildStrips() re-derives auxSlotTemplate from all isAux busses in
    // the project each time, see below).
    engine.rebuildBussesFromProject();
    refreshStructure();
}

void MixerPanel::paint(juce::Graphics& g) {
    g.fillAll(ui::bg());
}

void MixerPanel::resized() {
    auto r = getLocalBounds().reduced(12);
    auto titleRow = r.removeFromTop(20);
    addReturnBusButton.setBounds(titleRow.removeFromRight(90));
    titleRow.removeFromRight(8);
    title.setBounds(titleRow);
    r.removeFromTop(8);
    emptyLabel.setBounds(r);
    viewport.setBounds(r);
    layoutStrips();
}

void MixerPanel::refreshStructure() {
    rebuildStrips();
    resized();
}

void MixerPanel::refreshMeters() {
    for (size_t i = 0; i < trackStrips.size(); ++i) {
        if (const auto* m = engine.trackMeterAt(i)) {
            MeterFrame frame;
            if (m->read(frame))
                trackStrips[i]->setPeakDb(frame.peakDb);
        }
    }
    for (size_t i = 0; i < busStrips.size(); ++i) {
        if (const auto* m = engine.busMeterAt(i)) {
            MeterFrame frame;
            if (m->read(frame))
                busStrips[i]->setPeakDb(frame.peakDb);
        }
    }
}

void MixerPanel::rebuildStrips() {
    trackStrips.clear();
    busStrips.clear();
    stripContainer.removeAllChildren();
    // removeAllChildren() unparents noTracksHint too (it's a plain member,
    // not one of the unique_ptr-owned strips) -- re-add it before using it.
    stripContainer.addChildComponent(noTracksHint);

    const bool loaded = engine.isProjectLoaded();
    emptyLabel.setVisible(!loaded);
    viewport.setVisible(loaded);
    addReturnBusButton.setVisible(loaded);
    noTracksHint.setVisible(loaded && engine.trackCount() == 0);
    if (!loaded) {
        emptyLabel.setText("Load a project to open the mixer.", juce::dontSendNotification);
        return;
    }

    // Sends and the master/global busses are project-wide, not tied to any
    // particular song -- always build them, even with zero tracks staged,
    // so monitor mixes can be set up before a song exists or while browsing
    // the Builder with nothing selected for playback.
    std::vector<MixerStrip::SendSlot> auxSlotTemplate;
    for (const auto& b : engine.project().busses) {
        if (!b.isAux)
            continue;
        MixerStrip::SendSlot slot;
        slot.busId = b.id;
        slot.busLabel = juce::String(b.name.empty() ? b.id : b.name).substring(0, 4);
        auxSlotTemplate.push_back(slot);
    }

    // Physical-output bus picker options, shared by every track strip: only
    // non-aux busses are valid MAIN destinations (aux busses are sends-only,
    // reached via the per-track send knobs below, not this dropdown).
    std::vector<std::pair<std::string, juce::String>> mainBusOptions;
    for (const auto& b : engine.project().busses) {
        if (b.isAux)
            continue;
        mainBusOptions.emplace_back(b.id, juce::String(b.name.empty() ? b.id : b.name));
    }

    for (size_t i = 0; i < engine.trackCount(); ++i) {
        const TrackDef* def = engine.trackDefAt(i);
        juce::String name = def != nullptr
                                ? juce::String(def->name.empty() ? def->id : def->name)
                                : juce::String(engine.trackIdAt(i));
        auto strip = std::make_unique<MixerStrip>(MixerStrip::Kind::Track, name);
        strip->setStripColor(ui::trackColorForIndex(static_cast<int>(i)));
        if (def != nullptr) {
            strip->setGainDb(def->gainDb);
            strip->setPan(def->pan);
            strip->setMuted(def->mute);
            strip->setSoloed(def->solo);
            strip->setOutputBusOptions(mainBusOptions, def->busId);
        }
        // The Mixer only ever shows the currently-STAGED song's tracks (that's
        // what trackCount()/trackDefAt() are relative to), so these controls
        // always target engine.currentSongIndex() -- read fresh at click time
        // rather than captured now, in case this component somehow outlives
        // a song change before being rebuilt.
        const size_t idx = i;
        strip->onGainDb = [this, idx](double db) { engine.setTrackGainDb(engine.currentSongIndex(), idx, db); };
        strip->onPan = [this, idx](double p) { engine.setTrackPan(engine.currentSongIndex(), idx, p); };
        strip->onMute = [this, idx](bool m) { engine.setTrackMute(engine.currentSongIndex(), idx, m); };
        strip->onSolo = [this, idx](bool s) { engine.setTrackSolo(engine.currentSongIndex(), idx, s); };
        strip->onOutputBusChanged = [this, idx](std::string busId) {
            engine.setTrackBusId(engine.currentSongIndex(), idx, std::move(busId));
        };

        // Ableton-style send knobs: one per aux bus in the project, filled
        // in from this track's existing TrackSendDef entries (floor of
        // -60dB = "no send yet").
        std::vector<MixerStrip::SendSlot> slots = auxSlotTemplate;
        if (def != nullptr) {
            for (const auto& send : def->sends)
                for (auto& slot : slots)
                    if (slot.busId == send.busId)
                        slot.gainDb = send.gainDb;
        }
        strip->setSendSlots(slots);
        strip->onSendChanged = [this, idx, slots](size_t sendSlotIndex, double gainDb) {
            if (sendSlotIndex >= slots.size())
                return;
            const std::string busId = slots[sendSlotIndex].busId;
            const size_t songIdx = engine.currentSongIndex();
            const TrackDef* t = engine.trackDefAt(idx);
            if (t == nullptr)
                return;
            for (size_t si = 0; si < t->sends.size(); ++si) {
                if (t->sends[si].busId == busId) {
                    TrackSendDef updated = t->sends[si];
                    updated.gainDb = gainDb;
                    engine.setTrackSend(songIdx, idx, si, updated);
                    return;
                }
            }
            TrackSendDef newSend;
            newSend.busId = busId;
            newSend.gainDb = gainDb;
            newSend.enabled = true;
            engine.addTrackSend(songIdx, idx, newSend);
        };

        stripContainer.addAndMakeVisible(*strip);
        trackStrips.push_back(std::move(strip));
    }

    for (size_t i = 0; i < engine.busCount(); ++i) {
        auto strip = std::make_unique<MixerStrip>(MixerStrip::Kind::Bus, juce::String(engine.busNameAt(i)));
        strip->setGainDb(engine.busGainDb(i));
        strip->setMuted(engine.isBusMuted(i));
        strip->setSoloed(engine.isBusSoloed(i));
        if (i < engine.project().busses.size()) {
            const auto& b = engine.project().busses[i];
            strip->setSubtitle((b.isAux ? juce::String("SEND -> ch ") : juce::String("out ch "))
                               + juce::String(b.output.startChannel)
                               + (b.channels > 1 ? "-" + juce::String(b.output.startChannel + b.channels - 1) : juce::String()));
        }
        const size_t idx = i;
        strip->onGainDb = [this, idx](double db) { engine.setBusGainDb(idx, db); };
        strip->onMute = [this, idx](bool m) { engine.setBusMute(idx, m); };
        strip->onSolo = [this, idx](bool s) { engine.setBusSolo(idx, s); };
        stripContainer.addAndMakeVisible(*strip);
        busStrips.push_back(std::move(strip));
    }

    layoutStrips();
}

void MixerPanel::layoutStrips() {
    const int gap = 8;
    const int h = juce::jmax(280, viewport.getHeight() - 8);
    int x = 8;

    if (noTracksHint.isVisible()) {
        noTracksHint.setBounds(x, 8, 220, h);
        x += 220 + 16;
    }

    for (auto& s : trackStrips) {
        const int w = s->getPreferredWidth();
        s->setBounds(x, 8, w, h);
        x += w + gap;
    }
    if (!trackStrips.empty() && !busStrips.empty())
        x += 16; // visual separator before busses
    for (auto& s : busStrips) {
        const int w = s->getPreferredWidth();
        s->setBounds(x, 8, w, h);
        x += w + gap;
    }

    stripContainer.setSize(juce::jmax(viewport.getWidth(), x + 8), h + 16);
}

} // namespace resoset
