# SyncStage (v1.0) — Multi-Phone Synchronized Speaker System

SyncStage turns a group of phones and laptops into one synced, loud speaker system directly in the browser — **no app install, no account, and no music subscription required to join**.

One Host starts a room and shares a link or QR code; every connected phone locks clocks peer-to-peer over WebRTC DataChannels and schedules audio on the Web Audio hardware timeline.

---

## Features Across All 3 Modes

### 1. Files Tab (Frame-Accurate Multi-Phone Speaker)
- **Built-in 120 BPM Beat Test Track:** Synthesizes an 8-second stereo calibration track with sharp 2 kHz sync clicks, deep sub bass, and alternating L/R plucks — ready in 1 tap.
- **Direct P2P File Streaming:** Pick or drop any local `MP3`, `WAV`, `FLAC`, `OGG`, or `M4A` file. Chunks stream peer-to-peer over WebRTC DataChannels with flow control (`bufferedAmountLowThreshold`), decode locally into RAM, and start at an exact future Host timestamp.
- **200 ms Drift Corrector:** Compares playhead position against the synchronized clock every 200 ms with a `12 ms` deadband, `5 ms` release hysteresis, gentle `±0.2%` `playbackRate` nudging (`0.998x` / `1.002x`), and click-free re-anchoring if drift exceeds `80 ms`.

### 2. Cast Tab (Live Spotify / YT Music / Apple Music from PC Chrome or Edge)
- **Tab Audio Capture:** Uses `getDisplayMedia` + a 20 ms stereo `AudioWorklet` (`960 samples @ 48 kHz`) to capture any browser tab playing Spotify Web, YouTube Music, or Apple Music.
- **Timestamped Opus / PCM16 Over Unordered DataChannels:** Bypasses WebRTC's uncontrolled adaptive jitter buffer by wrapping encoded Opus frames (`128 kbps`, with automatic `PCM16` compatibility fallback) in a 20-byte timestamped binary packet over an unordered DataChannel and scheduling playout at a fixed room buffer (`500 ms`, `650 ms`, or `1000 ms`).
- **Host Monitor Toggle:** Lets the Host PC speakers stay in sync at the same buffer delay (mute the source Spotify/YT tab in Chrome to avoid double audio).

### 3. Remote Tab (Cross-Location YouTube Co-Listening)
- **YouTube & YT Music URL Sync:** Paste any `youtube.com`, `music.youtube.com`, or `youtu.be` link. Every connected peer loads the embedded YouTube IFrame player and re-syncs automatically when drift exceeds `450 ms`.

### 4. Loudness DSP, Spatial Roles & Party Polish
- **Audio DSP Chain:** `DelayNode (150 ms neutral base, ±150 ms manual tuning)` → `2×2 Channel Matrix (Full / Left / Right / Center)` → `Psychoacoustic Bass Enhancer (150–400 Hz harmonics)` → `Brickwall Limiter` → `Master Gain` → `60 FPS AnalyserNode`.
- **20-Sample Clock Sync Engine:** Fires 20 rapid pings over the P2P control channel, discards the slowest 75% Wi-Fi jitter outliers, maps Host time to `AudioContext.currentTime`, and re-syncs automatically every 45 seconds.
- **Friend Song Request Queue:** Any guest can request songs and upvote tracks in real time; the Host sees one-click YouTube/Spotify search links.
- **Open Chalkboard UI (Dark & Light Modes):** Zero-clutter monochrome + crimson UI with persistent Dark/Light theme toggle, Screen Wake Lock, background-tab alert in the Device Roster, and Wi-Fi AP Isolation / TURN fallback helper.

---

## Quick Start (Local Development)

Requires **Node.js 18+**.

```bash
# 1. Start the local server & signaling mirror
npm run dev
```

1. Open `http://localhost:3000` in **Chrome or Edge** on your PC and click **UNLOCK SPEAKER & JOIN**.
2. Click **QR / Invite** in the top bar. If you're on `localhost`, select your **Local Wi-Fi Address** in the dropdown so phones on the same Wi-Fi scan a reachable URL.
3. Scan the QR code on Android phones and tap **UNLOCK SPEAKER & JOIN**.

> **Note on HTTPS for mobile features:** Browsers restrict `Screen Wake Lock` and `getDisplayMedia` on plain `http://192.168.x.x` LAN addresses. For full mobile capabilities and internet-wide rooms, deploy to Cloudflare Workers (free tier) below.

---

## Free Deployment to Cloudflare (Workers + Durable Objects + Assets)

SyncStage uses Cloudflare solely as a lightweight WebSocket signaling matchmaker using the **WebSocket Hibernation API** and SQLite-backed Durable Objects (included on the **Cloudflare Workers Free Plan**). After WebRTC connects, all audio travels directly device-to-device.

```bash
# 1. Authenticate Wrangler with your Cloudflare account
npx wrangler login

# 2. Preview locally with Cloudflare's runtime
npm run cf:dev

# 3. Deploy static frontend + Durable Object signaling to Cloudflare
npm run cf:deploy
```

Wrangler prints your live `https://syncstage.<subdomain>.workers.dev` URL—open it on your PC and share the QR code with any phone.

---

## Party & Sync Tips

1. **Test Sync First:** Tap **BEAT TEST TRACK** (or **SYNC PULSE**) and adjust each phone's **Speaker Tuning (`-150 ms` to `+150 ms`)** slider if one device uses Bluetooth or has speaker hardware lag.
2. **Casting Spotify / YT Music:**
   - Open Spotify Web or YT Music in a Chrome/Edge tab.
   - In SyncStage **Cast**, click **CAPTURE TAB AUDIO**, choose **Chrome Tab**, select the music tab, and make sure **"Share tab audio"** is checked.
   - Right-click the music tab in Chrome and click **Mute site** if you want the Host PC speakers to play via SyncStage's synced **Host Monitor** without hearing an immediate early copy.
3. **Acoustic Volume Boost:** Enable **Bass Enhance** + **Limiter**, place phones face-up on a hard wooden table (or inside an empty ceramic mug/bowl), and keep screens unlocked while playing.
4. **If Phones Can't Connect Over Public/Campus Wi-Fi:** Some routers enable **AP Isolation** (blocking phone-to-phone local traffic). Switch to a phone Wi-Fi hotspot or configure a TURN relay in the **Configure TURN** dialog when alerted.

---

## Project Architecture & File Map

```text
├── wrangler.toml                   # Cloudflare Workers + Static Assets + Durable Object config
├── worker/index.js                 # Cloudflare Worker router & RoomSession Hibernation DO
├── dev-server.js                   # Zero-dependency local HTTP + RFC 6455 WebSocket mirror
├── public/
│   ├── index.html                  # Open chalkboard UI (Landing + Room Workspace)
│   ├── css/styles.css              # Dark & Light chalkboard gradient themes + red accents
│   └── js/
│       ├── app.js                  # App state, signaling, UI controller
│       ├── rtc-mesh.js             # Star-topology WebRTC mesh (control, audio, cast channels)
│       ├── clock-sync.js           # 20-sample lowest-RTT 25% NTP clock lock
│       ├── audio-dsp.js            # Delay, 2x2 role matrix, harmonic bass, brickwall limiter
│       ├── audio-unlock.js         # Mobile AudioContext unlocker, Wake Lock & test pulse
│       ├── tab-files.js            # P2P file transfer, 120 BPM WAV generator & drift loop
│       ├── pcm-capture-worklet.js  # 20 ms stereo AudioWorklet capture processor
│       ├── tab-cast.js             # Live tab capture, Opus/PCM16 framing & playout scheduler
│       ├── tab-remote.js           # YouTube IFrame remote co-listening sync
│       ├── requests.js             # P2P song request & upvote queue
│       ├── visualizer.js           # 60 FPS Canvas spectrum & 21-bar chalkboard waveform
│       └── qrcode.js               # Pure-JS ISO/IEC 18004 SVG QR generator
├── test-release1.js                # Integration test: HTTP assets, WS signaling, QR & ClockSync
├── test-release2.js                # Unit test: File chunks, WAV synthesis, drift & DSP curves
└── test-release345.js              # Unit test: Cast framing, YouTube parser & Song Requests
```

## Running Tests

```bash
# Run pure unit tests (Releases 2-5)
npm run test:unit

# Run full test suite (Releases 1-5)
npm test
```
