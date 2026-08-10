#pragma once

namespace resostage {

/**
 * How hard the machine is being asked to slow itself down.
 *
 * A laptop under thermal pressure reduces its clocks and moves work onto
 * efficiency cores. Nothing in the app changes -- the same show, the same
 * buffer, the same stems -- and the audio starts breaking up anyway. It is
 * the single most confusing failure a live rig has, because every number the
 * operator can see says the machine is fine, and it usually happens an hour
 * into a set when the room is warm.
 *
 * So this is reported, not acted on. There is a real argument for degrading
 * automatically -- dropping the interpolator, thinning the UI -- but quietly
 * changing how a show sounds or looks partway through it is a worse surprise
 * than the throttling. Telling the operator lets them decide.
 */
enum class ThermalState {
    /** No pressure, or the platform does not report any. */
    Nominal,
    /** Fans up, mild clock reduction. */
    Fair,
    /** Sustained throttling; audio headroom is genuinely reduced. */
    Serious,
    /** The system is shedding work to protect itself. */
    Critical,
};

/**
 * Current thermal pressure. Cheap enough to poll at telemetry rate.
 *
 * Returns Nominal on platforms with no equivalent notion rather than
 * pretending to know -- an invented reading would be worse than none, because
 * this exists precisely to be believed when everything else looks healthy.
 */
ThermalState currentThermalState();

/** Stable lower-case name for the wire and the UI. */
const char* thermalStateName(ThermalState state);

} // namespace resostage
