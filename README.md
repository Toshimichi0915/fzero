# NEON ZERO — Grand Prix 2099

An F-Zero-style anti-gravity racer set in a neon megacity, built for the browser with
Three.js and a custom HDR pipeline. 31 machines race on a 16 km circuit through six
districts:

- **Mute City**: start straight and pit.
- **Downtown core**: a helix around the megatower.
- **Port Town "Double Branches"**, over the bay. Three intertwined routes:
  - an outside pipe you can drive all the way around, upside down underneath;
  - a skyway that weaves over it and rolls upside down;
  - a glass tube that splits off the skyway.
- **Neo-Kyoto**: torii gates, a vertical loop, a wall ride, a corkscrew tunnel and a
  hairpin.
- **Arcology**: a vertical climb up to a sky road and a 150 m drop.
- **Fire Field**: a half-pipe, a glass tube, open-edge hills with no rails, and a jump
  plate.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production build in dist/ (serve with `npm run preview`)
```

Use **Chrome or Edge** (WebGL2; WebHID for the DualSense extras). A discrete GPU is
recommended. Lower *Settings → Resolution* if needed.

## Controls

| Action | DualSense | Keyboard |
| --- | --- | --- |
| Accelerate | R2 (analog) or ✕ | W / ↑ |
| Steer | Left stick / D-pad | A D / ← → |
| Air brake | L2 | S / ↓ |
| Boost (from lap 2, costs power) | ○ | Space |
| Lean / drift | L1 / R1 | Q / E |
| Side attack | double-tap L1 / R1 | double-tap Q / E |
| Spin attack | □ | F |
| Air pitch (dive / float) | Left stick ↕ | — |
| Camera | △ | C |
| Look back | Touchpad click | R |
| Pause | Options | Esc / P |

Hold accelerate the moment **GO** appears for a rocket start. The pink strip on
the main straight is the pit zone and recharges power. When power reaches zero,
one more hit destroys your machine.

## DualSense

- Works out of the box through the Gamepad API (USB or Bluetooth): analog triggers,
  sticks and rumble.
- **Settings → Connect DualSense (HID)** turns on the WebHID extras:
  - **Adaptive triggers.** R2 resistance rises with speed. R2 vibrates while boosting.
    L2 has air-brake resistance.
  - **Lightbar.** Shows your machine's thruster colour, flashes white on boost and
    pulses red at low power.
  - **Player LEDs.** Show the current lap.
  - **Rumble.** Driven by the game's haptics.
- On Linux, WebHID needs read/write access to the controller's hidraw node. A udev
  rule such as

  ```
  # /etc/udev/rules.d/70-dualsense.rules
  KERNEL=="hidraw*", ATTRS{idVendor}=="054c", ATTRS{idProduct}=="0ce6", MODE="0666", TAG+="uaccess"
  KERNEL=="hidraw*", KERNELS=="*054C:0CE6*", MODE="0666", TAG+="uaccess"
  ```

  followed by `sudo udevadm control --reload && sudo udevadm trigger` (and
  re-plugging the controller) takes care of it.

## Tech notes

- `src/track` builds the course with a turtle builder: straights, eased turns, helix,
  loop, corkscrew, jump and Hermite joins. Frames are rotation-minimising and made
  upright outside loops. The same module generates the road, slab, energy barriers,
  tunnel, supports and pads.
- `src/vehicles` holds the track-relative hover physics: heading and slip, walls,
  forks, gaps, ballistic flight with air control, rescue, energy and attacks. It also
  has the AI (racing line, corner-speed planning, overtaking, pit use, boosting,
  fork choice) and procedural hull models with a livery shader.
- `src/fx`:
  - View-dependent thruster glows with anamorphic streaks and exhaust plumes.
  - Light trails and particles.
  - Per-pixel thruster light on the road.
  - Planar wet-road reflections.
  - Rain.
- `src/world`:
  - A procedural city of about 12k instanced buildings with shader windows, around
    a megatower.
  - A hologram dragon, a holo globe, ad billboards and checkpoint arches.
  - A start gate with countdown lights.
  - Flying traffic, searchlights, an ad airship and the sky (moon, ringed gas giant,
    aurora, far skyline).
- `src/core/Renderer.ts` runs the post chain: HDR, MSAA, sanitize, mipmap bloom,
  radial speed blur, chromatic aberration, ACES tone mapping, vignette and grain.
- `src/audio` is fully procedural: engine synthesis, HRTF doppler fly-bys, sound
  effects and a generative synthwave soundtrack.

Debug URL flags: `?race` skips straight to a race, and `&m=0..3` picks the machine.
