#include "doctest.h"
#include "midi/MidiTransform.h"

using namespace resostage;

TEST_SUITE("MidiTransform") {
    TEST_CASE("FaderLaw logarithmic audio taper") {
        // Zero position is silence
        CHECK(FaderLaw::positionToGain(0.0f) == 0.0f);
        CHECK(FaderLaw::positionToDb(0.0f) <= -80.0f);

        // 0.80 is standard DAW unity (0 dB)
        CHECK(doctest::Approx(FaderLaw::positionToDb(0.80f)).epsilon(0.01) == 0.0f);
        CHECK(doctest::Approx(FaderLaw::positionToGain(0.80f)).epsilon(0.01) == 1.0f);

        // 1.00 is +12 dB
        CHECK(doctest::Approx(FaderLaw::positionToDb(1.00f)).epsilon(0.01) == 12.0f);

        // Roundtrip position -> dB -> position
        for (float pos : {0.1f, 0.25f, 0.5f, 0.8f, 0.95f, 1.0f}) {
            const float db = FaderLaw::positionToDb(pos);
            const float roundtrip = FaderLaw::dbToPosition(db);
            CHECK(doctest::Approx(roundtrip).epsilon(0.02) == pos);
        }
    }

    TEST_CASE("FrequencyScale logarithmic 20Hz - 20kHz") {
        CHECK(doctest::Approx(FrequencyScale::positionToHz(0.0f)).epsilon(0.01) == 20.0f);
        CHECK(doctest::Approx(FrequencyScale::positionToHz(1.0f)).epsilon(0.01) == 20000.0f);
        // Midpoint 0.5 is 20 * sqrt(1000) ~ 632.45 Hz (not 10,010 Hz linear!)
        CHECK(doctest::Approx(FrequencyScale::positionToHz(0.5f)).epsilon(0.05) == 632.45f);

        // Roundtrip
        for (float f : {30.0f, 100.0f, 440.0f, 1000.0f, 5000.0f, 15000.0f}) {
            const float pos = FrequencyScale::hzToPosition(f);
            const float roundtrip = FrequencyScale::positionToHz(pos);
            CHECK(doctest::Approx(roundtrip).epsilon(0.01) == f);
        }
    }

    TEST_CASE("Controller Takeover Pickup / Soft Takeover") {
        ControllerTakeoverState takeover;
        takeover.mode = TakeoverMode::Pickup;

        const float currentSoftwareTarget = 0.70f;

        // Physical controller starts at 0.20 (does not match target)
        float out = takeover.process(0.20f, currentSoftwareTarget);
        CHECK(out == currentSoftwareTarget);
        CHECK_FALSE(takeover.latched);

        // Physical moves to 0.40 (still hasn't crossed)
        out = takeover.process(0.40f, currentSoftwareTarget);
        CHECK(out == currentSoftwareTarget);
        CHECK_FALSE(takeover.latched);

        // Physical moves across 0.70 to 0.72 -> Latches!
        out = takeover.process(0.72f, currentSoftwareTarget);
        CHECK(takeover.latched);
        CHECK(out == 0.72f);

        // Subsequent movements track 1:1
        out = takeover.process(0.65f, 0.72f);
        CHECK(out == 0.65f);
    }

    TEST_CASE("Relative Encoder Decoders") {
        // Two's complement 7-bit
        CHECK(RelativeEncoder::decodeTwosComplement7(1) == 1);
        CHECK(RelativeEncoder::decodeTwosComplement7(63) == 63);
        CHECK(RelativeEncoder::decodeTwosComplement7(127) == -1);
        CHECK(RelativeEncoder::decodeTwosComplement7(126) == -2);
        CHECK(RelativeEncoder::decodeTwosComplement7(65) == -63);
        CHECK(RelativeEncoder::decodeTwosComplement7(0) == 0);

        // Binary Offset
        CHECK(RelativeEncoder::decodeBinaryOffset(65) == 1);
        CHECK(RelativeEncoder::decodeBinaryOffset(63) == -1);
        CHECK(RelativeEncoder::decodeBinaryOffset(64) == 0);

        // Signed Bit
        CHECK(RelativeEncoder::decodeSignedBit(1) == 1);
        CHECK(RelativeEncoder::decodeSignedBit(0x41) == -1); // bit 6 set, magnitude 1
        CHECK(RelativeEncoder::decodeSignedBit(0) == 0);
    }
}
