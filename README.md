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
has no back, it cannot turn away from you, and it cannot lunge. Instead it is a
rigged, animated 3D model, `public/assets/ghost.glb`: a sculpted head wearing
the face art from `public/assets/ghot.webp`, a hood, a ragged mantle, a
tattered floor-length shroud and long clawed hands, on a 22-bone skeleton.

It has three animations. **Idle** floats and sways, and the head twitches.
**Chase** leans in with the arms reaching and the shroud streaming behind; the
game blends between the two by how fast the ghost is actually moving. **Lunge**
flings the arms wide and then grabs, and the jumpscare scrubs it with its own
0..1 lunge value, so the catch happens in the scene, in three dimensions.

The model is built entirely by a script, in Blender:

    E:/Blender/blender.exe --background --factory-startup --python tools/build-ghost.py

It sculpts the head so its sockets, cheeks and mouth sit under the matching
features of the art, projects the art onto it (levelled, since it is tilted
about 16 degrees in its frame), bakes colour and ambient occlusion to textures
with Cycles, rigs and animates it, and exports the GLB. It is deterministic, so
to change the ghost, or to swap in new face art, edit the script or replace
`ghot.webp` and re-run it. Pass `-- out.glb preview_dir` to also render
turnaround and pose previews.

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

## Multiplayer

One player hosts, the rest join with a six-character room code. The host picks
who plays; everyone else chooses in the lobby whether they want to be the
ghost or a survivor, and the host resolves it at the start — first to ask gets
the ghost, and if nobody asks the host takes it, because a match with no ghost
is not a match. Bots fill out the survivor side so two people still get a hunt.

### How it works

Host-authoritative over WebRTC. One player's machine runs the simulation and
broadcasts the world twenty times a second; everyone else sends what they are
trying to do thirty times a second and draws what they are sent.

This is what the intent boundary was for from the first commit. `sim.step`
takes a map of intents and returns the next state — so a remote player, a bot
and the host's own keyboard are indistinguishable to it, and adding the
network meant filling that map from a different source rather than changing
the simulation at all.

Clients do not predict. Prediction would hide the latency on your own
movement, but it brings reconciliation, rollback, and a class of bug where
your screen and the host's quietly disagree. Instead the world is played back
100ms behind live and interpolated between snapshots, so uneven packet arrival
does not show as stutter. The cost is a little input lag; the benefit is that
what you see is always something the host actually believes happened.

A client never sends a position, only an intent, so nobody walks through a
wall or catches someone from across the house by lying about where they are.

`npm run mptest` drives two real browsers through a whole match — host, join,
start, and then checks the client's world tracks the host's and that the host
sees the client's input. None of that is visible to a typechecker or to a
single browser.

### Hosting it

The game is static files and the multiplayer is peer-to-peer, so there is no
server to run and nothing to pay for. `.github/workflows/deploy.yml` publishes
to GitHub Pages on every push to `main`.

Signalling — the introduction between two peers — uses PeerJS's free public
broker. It is only used to exchange connection details; once a match starts
the traffic goes directly between players.

Practical limits worth knowing: the host's connection quality decides
everyone's, six to eight players is the ceiling, and if the host leaves the
match ends. A dedicated relay would fix all three and cost either money or a
free tier that sleeps between sessions.

## Not built yet

**Voice chat.** The ghost's voice transformation exists and works, but it
currently only processes your own microphone locally. Carrying real voice
between players means adding a media stream to the existing peer connection,
which is a small addition to `net/host.ts` and `net/client.ts` — the audio
graph that would receive it is already built.

**Host migration.** If the host leaves, the match ends. Handing authority to
another peer is possible but fiddly, and a dedicated relay would be the
simpler answer if it ever matters.

## Content warning

Sudden loud noises, flashing imagery and jump scares.
