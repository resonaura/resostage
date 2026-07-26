#pragma once

#include <juce_gui_basics/juce_gui_basics.h>

#include "ui/LevelMeter.h"
#include "ui/UiColors.h"

#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace resoset {

// One channel strip: name, vertical fader (dB), pan, mute, solo, peak meter.
class MixerStrip final : public juce::Component {
public:
    enum class Kind { Track, Bus };

    MixerStrip(Kind kind, juce::String name)
        : stripKind(kind) {
        nameLabel.setText(name, juce::dontSendNotification);
        nameLabel.setJustificationType(juce::Justification::centred);
        nameLabel.setColour(juce::Label::textColourId, ui::text());
        nameLabel.setFont(juce::Font(juce::FontOptions(12.0f, juce::Font::bold)));
        addAndMakeVisible(nameLabel);

        subLabel.setJustificationType(juce::Justification::centred);
        subLabel.setColour(juce::Label::textColourId, ui::muted());
        subLabel.setFont(juce::Font(juce::FontOptions(10.0f)));
        subLabel.setVisible(kind == Kind::Bus); // Track strips show the interactive outputBusBox instead

        // Track-only: which bus this track's MAIN output routes to, editable
        // directly here instead of only in the Builder -- picking one of the
        // "1/2"-style channel-pair busses here is how you send a track to a
        // specific physical output pair without leaving the Mixer. Item ID 1
        // is always the explicit "(sends only)" option (AudioEngine's
        // empty-busId convention); IDs 2..N+1 map to comboBusIds[0..N-1].
        outputBusBox.setColour(juce::ComboBox::backgroundColourId, ui::panelAlt());
        outputBusBox.setColour(juce::ComboBox::textColourId, ui::text());
        outputBusBox.setColour(juce::ComboBox::outlineColourId, ui::border());
        outputBusBox.setVisible(kind == Kind::Track);
        outputBusBox.onChange = [this] {
            if (!onOutputBusChanged)
                return;
            const int id = outputBusBox.getSelectedId();
            const size_t idx = static_cast<size_t>(id - 2);
            onOutputBusChanged(id >= 2 && idx < comboBusIds.size() ? comboBusIds[idx] : std::string());
        };
        addAndMakeVisible(outputBusBox);
        addAndMakeVisible(subLabel);

        fader.setSliderStyle(juce::Slider::LinearVertical);
        fader.setTextBoxStyle(juce::Slider::TextBoxBelow, false, 52, 18);
        fader.setRange(-60.0, 12.0, 0.1);
        fader.setValue(0.0, juce::dontSendNotification);
        fader.setColour(juce::Slider::thumbColourId, ui::accent());
        fader.setColour(juce::Slider::trackColourId, ui::border());
        fader.onValueChange = [this] {
            if (onGainDb)
                onGainDb(fader.getValue());
        };
        addAndMakeVisible(fader);

        pan.setSliderStyle(juce::Slider::RotaryHorizontalVerticalDrag);
        pan.setTextBoxStyle(juce::Slider::NoTextBox, false, 0, 0);
        pan.setRange(-1.0, 1.0, 0.01);
        pan.setValue(0.0, juce::dontSendNotification);
        pan.setColour(juce::Slider::rotarySliderFillColourId, ui::accent());
        pan.setColour(juce::Slider::rotarySliderOutlineColourId, ui::border());
        pan.setEnabled(kind == Kind::Track);
        pan.setVisible(kind == Kind::Track);
        pan.onValueChange = [this] {
            if (onPan)
                onPan(pan.getValue());
        };
        addAndMakeVisible(pan);

        mute.setButtonText("M");
        mute.setClickingTogglesState(true);
        mute.setColour(juce::TextButton::buttonOnColourId, ui::warn());
        mute.setColour(juce::TextButton::textColourOnId, juce::Colours::black);
        mute.onClick = [this] {
            if (onMute)
                onMute(mute.getToggleState());
        };
        addAndMakeVisible(mute);

        solo.setButtonText("S");
        solo.setClickingTogglesState(true);
        solo.setColour(juce::TextButton::buttonOnColourId, juce::Colour(0xfff5d76e));
        solo.setColour(juce::TextButton::textColourOnId, juce::Colours::black);
        solo.onClick = [this] {
            if (onSolo)
                onSolo(solo.getToggleState());
        };
        addAndMakeVisible(solo);

        addAndMakeVisible(meter);

        kindBadge.setText(kind == Kind::Track ? "TRK" : "BUS", juce::dontSendNotification);
        kindBadge.setJustificationType(juce::Justification::centred);
        kindBadge.setColour(juce::Label::textColourId, ui::muted());
        kindBadge.setFont(juce::Font(juce::FontOptions(9.0f)));
        addAndMakeVisible(kindBadge);
    }

    void setStripName(const juce::String& n) { nameLabel.setText(n, juce::dontSendNotification); }
    void setSubtitle(const juce::String& s) { subLabel.setText(s, juce::dontSendNotification); }

    // Track-only: populates the output-bus picker with every non-aux
    // (physical output) bus in the project and selects `currentBusId`
    // (empty = "(sends only)"). No-op for Bus strips.
    void setOutputBusOptions(const std::vector<std::pair<std::string, juce::String>>& busses,
                              const std::string& currentBusId) {
        if (stripKind != Kind::Track)
            return;
        comboBusIds.clear();
        outputBusBox.clear(juce::dontSendNotification);
        outputBusBox.addItem("(sends only)", 1);
        int selectId = 1;
        for (const auto& [busId, label] : busses) {
            comboBusIds.push_back(busId);
            const int itemId = static_cast<int>(comboBusIds.size()) + 1;
            outputBusBox.addItem(label, itemId);
            if (busId == currentBusId)
                selectId = itemId;
        }
        outputBusBox.setSelectedId(selectId, juce::dontSendNotification);
    }

    void setGainDb(double db, juce::NotificationType n = juce::dontSendNotification) {
        fader.setValue(db, n);
    }
    void setPan(double p, juce::NotificationType n = juce::dontSendNotification) {
        pan.setValue(p, n);
    }
    void setMuted(bool m, juce::NotificationType n = juce::dontSendNotification) {
        mute.setToggleState(m, n);
    }
    void setSoloed(bool s, juce::NotificationType n = juce::dontSendNotification) {
        solo.setToggleState(s, n);
    }
    void setPeakDb(float peakDb) { meter.setLevel(peakDb); }

    // One small rotary knob per aux (send-target) bus in the project,
    // Ableton-style: every track strip shows a knob for every available
    // send, not just the ones it currently uses -- turning a knob up from
    // its floor implicitly creates that track's send if it didn't exist yet
    // (handled by the owner via onSendChanged; this class only renders and
    // reports raw dB values). Track strips only; no-op for Bus strips.
    struct SendSlot {
        std::string busId;
        juce::String busLabel;
        double gainDb = -60.0;
    };
    void setSendSlots(const std::vector<SendSlot>& slots) {
        sendKnobs.clear();
        if (stripKind != Kind::Track)
            return;
        for (size_t i = 0; i < slots.size(); ++i) {
            auto ui = std::make_unique<SendKnobUi>();
            ui->knob.setSliderStyle(juce::Slider::RotaryHorizontalVerticalDrag);
            ui->knob.setTextBoxStyle(juce::Slider::NoTextBox, false, 0, 0);
            ui->knob.setRange(-60.0, 6.0, 0.1);
            ui->knob.setValue(slots[i].gainDb, juce::dontSendNotification);
            ui->knob.setColour(juce::Slider::rotarySliderFillColourId, ui::warn());
            ui->knob.setColour(juce::Slider::rotarySliderOutlineColourId, ui::border());
            const size_t idx = i;
            juce::Slider& knobRef = ui->knob; // stable: SendKnobUi lives on the heap, only the unique_ptr moves
            ui->knob.onValueChange = [this, idx, &knobRef] {
                if (onSendChanged)
                    onSendChanged(idx, knobRef.getValue());
            };
            addAndMakeVisible(ui->knob);

            ui->label.setText(slots[i].busLabel, juce::dontSendNotification);
            ui->label.setJustificationType(juce::Justification::centred);
            ui->label.setColour(juce::Label::textColourId, ui::muted());
            ui->label.setFont(juce::Font(juce::FontOptions(8.0f)));
            addAndMakeVisible(ui->label);

            sendKnobs.push_back(std::move(ui));
        }
        resized();
    }

    int getPreferredWidth() const {
        const int perSend = 26;
        return juce::jmax(92, 16 + static_cast<int>(sendKnobs.size()) * perSend);
    }

    std::function<void(double)> onGainDb;
    std::function<void(double)> onPan;
    std::function<void(bool)> onMute;
    std::function<void(bool)> onSolo;
    std::function<void(size_t sendSlotIndex, double gainDb)> onSendChanged;
    std::function<void(std::string busId)> onOutputBusChanged; // busId empty == "(sends only)"

    void paint(juce::Graphics& g) override {
        g.setColour(ui::panel());
        g.fillRoundedRectangle(getLocalBounds().toFloat(), 8.0f);
        g.setColour(ui::border());
        g.drawRoundedRectangle(getLocalBounds().toFloat().reduced(0.5f), 8.0f, 1.0f);
    }

    void resized() override {
        auto r = getLocalBounds().reduced(6);
        kindBadge.setBounds(r.removeFromTop(14));
        nameLabel.setBounds(r.removeFromTop(18));
        auto subRow = r.removeFromTop(16);
        subLabel.setBounds(subRow);
        outputBusBox.setBounds(subRow);

        if (!sendKnobs.empty()) {
            auto sendRow = r.removeFromTop(36);
            const int knobW = juce::jmax(20, sendRow.getWidth() / static_cast<int>(sendKnobs.size()));
            for (auto& k : sendKnobs) {
                auto cell = sendRow.removeFromLeft(knobW);
                k->knob.setBounds(cell.removeFromTop(24).withSizeKeepingCentre(22, 22));
                k->label.setBounds(cell);
            }
            r.removeFromTop(4);
        }

        auto bottom = r.removeFromBottom(28);
        mute.setBounds(bottom.removeFromLeft(bottom.getWidth() / 2).reduced(1));
        solo.setBounds(bottom.reduced(1));
        r.removeFromBottom(4);

        if (stripKind == Kind::Track) {
            pan.setBounds(r.removeFromBottom(44).withSizeKeepingCentre(40, 40));
            r.removeFromBottom(2);
        }
        auto meterArea = r.removeFromRight(14);
        meter.setBounds(meterArea.reduced(0, 4));
        r.removeFromRight(4);
        fader.setBounds(r);
    }

private:
    struct SendKnobUi {
        juce::Slider knob;
        juce::Label label;
    };

    Kind stripKind;
    juce::Label kindBadge;
    juce::Label nameLabel;
    juce::Label subLabel;
    juce::ComboBox outputBusBox;
    std::vector<std::string> comboBusIds; // index i -> item ID (i + 2)
    juce::Slider fader;
    juce::Slider pan;
    juce::TextButton mute;
    juce::TextButton solo;
    LevelMeter meter;
    std::vector<std::unique_ptr<SendKnobUi>> sendKnobs;
};

} // namespace resoset
