# The House

An asymmetric first-person horror game for the browser. One player is the
ghost; everyone else is trying to find the key and get out of the house before
they are caught.

Built with TypeScript, Three.js and Web Audio. No install, no plugins — it runs
in a browser tab.

```bash
npm install
npm run dev      # http://localhost:5173
npm run check    # typecheck
npm run build    # production bundle
```

## The game

**Survivors** search a decaying South Asian house for a single iron key hidden
in a random room, then carry it to the main gate. They can sprint in short
bursts, crouch to move quietly, and hide inside wooden almirahs or under
charpoys and tables.

**The ghost** hunts them. It moves faster than a walking survivor but slower
than a sprinting one, so a survivor with stamina can break away — briefly.
Every thirty seconds the house shows the ghost where everyone *was*, for three
seconds.

### Win conditions

| Outcome | Condition |
| --- | --- |
| Survivors win | At least one survivor gets through the gate with the key |
| Ghost wins | Every survivor is caught |
| Ghost wins | **The key holder is caught** — the way out goes into the dark with them |

That last rule is the sharp one. Picking up the key makes you the most
important person in the building and the most dangerous person to be near.

### Controls

| Key | Action |
| --- | --- |
| `W` `A` `S` `D` | Move |
| `Shift` | Sprint (survivors have limited stamina; the ghost does not tire) |
| `Ctrl` / `C` | Crouch — much quieter, and fits under low furniture |
| `E` | Take the key, hide, or climb out |
| `Space` / click | Catch (ghost only) |
| `Esc` | Release the mouse |

## Design decisions worth knowing

**There is no map.** Not a minimap, not a compass, not a room name. You learn
the house by playing it. Every room therefore has its own wall tint, floor
colour and lamp colour, and that palette is the entire navigation system — it
is load-bearing, not decoration. The courtyard at the centre is the one place
open to the sky, which makes it both the landmark you orient by and the most
dangerous room to cross.

**The reveal pulse shows a snapshot, not a tracker.** It reports where each
survivor stood at the instant it fired, and the ghost sees that for three
seconds. Those three seconds of running are the counterplay. A live tracker
would simply end the round.

**Stamina punishes mashing.** Regeneration only begins 1.2s after you stop
sprinting, and once you hit zero you cannot sprint again until you have
recovered a full second's worth. Without those two rules, tapping sprint is
strictly better than holding it, and the interesting decision — *when* do I
run? — disappears.

**Hiding is a commitment.** Inside an almirah your view is locked to a narrow
cone in one direction; you cannot turn around. The ghost cannot see you, but it
can open the door, and from the outside a closed almirah looks different from
an open one. Being found in a locker should feel like being found, not like
losing a dice roll.

**The catch needs range, a facing cone, and line of sight.** It is an action
aimed at a person, not an area sweep.

## The ghost's voice

The brief called this "a challenge probably", and the obvious approach does not
work. The Web Speech API is speech *recognition* — it returns text, so routing
a voice through it throws away timing, tone, and everything that makes a human
ghost frightening, and hands back a robot reading a transcript.

So the raw microphone stream goes through a Web Audio chain instead, and the
player's actual performance survives with a mask on:

1. **High-pass** — strips rumble and mic handling noise
2. **Pitch shift** — about a fifth down, granular resampling in an AudioWorklet
3. **Ring modulator** — a slow carrier for the metallic detune that reads as
   "not a person" without destroying the words
4. **Waveshaper** — soft saturation, so shouting tears
5. **Convolver** — a long, dark reverb tail; the house answering
6. **Low-pass** — takes the top off so it sits behind the world

The chain runs on the *listener's* machine and feeds a `PannerNode`, so
distance attenuation and the ghost effect compose for free: a distant ghost is
both quieter and less intelligible. The effect also intensifies with proximity
— a warped whisper across the house, fully inhuman at catching range.

Survivor voices are left untouched. The asymmetry is the point.

## Sound is the instrument

With no map, audio is how you know anything about where anyone is. Footsteps
and voices are placed with HRTF panning and inverse-distance rolloff, so
"louder when nearer" is not a curve anyone wrote — it falls out of the
listener's position, updated from the camera every frame.

Crouching drops footstep volume to a quarter and slows the step rate, which is
the entire reason to accept the speed penalty. Sprinting is loud enough to give
away your position across several rooms. **Headphones are strongly recommended.**

## Bots

Both roles have bots, so the game is fully playable and testable solo — hunt
bot survivors as the ghost, or hide alongside them as a survivor.

Bots navigate with A* over a half-metre grid rebuilt from the map's collision
boxes, with string-pulled paths. This matters more than it sounds: the first
version steered straight at its target and sidestepped on a sine wave when
blocked, which pinned the ghost against the courtyard wall for an entire match
at a tenth of its speed. A chase where nobody can cross the house is not a
difficulty setting, it is a broken game.

The ghost bot is deliberately held to the same information a human ghost gets:
it sees what is in front of it within a field of view, it hears footsteps
within a radius, and it gets the pulse. It does not know where hidden survivors
are — it checks hiding places on suspicion, which is where the tension lives.
You hear it open the almirah next to yours.

## Project layout

```
src/
  core/vec.ts          angle and distance helpers, seeded PRNG
  game/
    config.ts          every tuning number, in one place
    types.ts           shared state shapes
    map.ts             the house: walls, furniture, hiding spots, spawns
    collision.ts       AABB collision with a real height axis
    intent.ts          what an actor wants to do this tick
    sim.ts             the authoritative rules
    input.ts           keyboard and mouse, pointer lock
  ai/
    navigate.ts        nav grid, A*, path following
    survivorBot.ts     search, flee, hide
    ghostBot.ts        patrol, chase, investigate, search hiding spots
  audio/
    engine.ts          spatial audio, footsteps, stingers
    ghostVoice.ts      the voice transformation chain
  render/
    world.ts           house geometry, per-room palettes, lighting
    ghostModel.ts      the ghost's animated body  ← swap the artwork here
    actors.ts          survivor bodies, reveal-pulse columns
    jumpscare.ts       the catch
    renderer.ts        camera, view switching, spectator mode
  ui/hud.ts            stamina, prompts, no map
  main.ts              fixed-timestep game loop
```

### The simulation boundary

`sim.ts` does not draw, play sound, or read the keyboard. One `step()` takes
the state plus one intent per actor and returns the next state. Humans and bots
both produce nothing but intents.

That boundary is deliberate: it is what lets a bot and a networked player be
the same thing to the simulation, and it is what host-authoritative netcode
needs. The sim also runs at a fixed 60Hz regardless of frame rate, because a
simulation whose outcome depends on the host's frame rate cannot be replicated
on another machine.

## The ghost's artwork

The ghost is **not** a billboard sprite. A camera-facing image is cheap, but it
has no back, it cannot turn away from you, and it cannot lunge. Instead the
artwork is a texture on real geometry: a face plate on a built head, over a
torso, arms and a trailing shroud that sway, breathe and drift independently.

That buys three things. It reads as the ghost from behind. It animates. And at
the catch it lunges *at* the camera in three dimensions — the difference
between a scare and a picture of one.

The texture lives at `public/assets/ghost.png`. What is there now is a
generated stand-in — a gaunt corpse-pale skull with sunken red eyes and
irregular fangs, built by `tools/make-ghost.py` from signed distance fields and
a lighting model rather than drawn shapes, because outlined ellipses give you a
cartoon and it is the shading that carries the anatomy.

Replace that file with the real artwork whenever it is available; nothing else
changes, since `GHOST_TEXTURE_URL` in `render/ghostModel.ts` already points
there. The face is mapped to a curved plane with a clean 0..1 UV square, so a
transparent PNG lands exactly as drawn.

## A note on what the tests caught

Several bugs in this code were invisible to reading and only fell out of
measuring:

- The camera faced the opposite way to the movement code, so `W` walked
  backwards. Found by comparing the camera's forward vector against the sim's
  for every yaw, not by playing.
- Dying cut to the spectator orbit on the same frame the jumpscare began, so
  the scare played out correctly twenty-six metres in the air where nobody
  could see it.
- `await audio.resume()` could never settle if the browser declined to start
  an AudioContext, leaving the game hanging on a black screen — a silent game
  is bad, a frozen one is much worse.
- The ghost's face was a patch of `SphereGeometry`, which put it on the side
  of the head *and* inherited a narrow slice of the sphere's global UVs, so
  the artwork never showed at all.

## Not built yet

**Multiplayer.** The architecture is laid out for it — intents, fixed
timestep, an authoritative sim — but there is no networking layer. The plan is
WebRTC peer-to-peer with the host running the authoritative simulation, joined
by room code, which also carries the voice streams the ghost effect needs.

Until then every other role is a bot, which is enough to play and more than
enough to tune.

## Content warning

Sudden loud noises, flashing imagery and jump scares.
