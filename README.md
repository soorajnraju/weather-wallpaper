# Weather Wallpaper

A macOS app that turns your desktop wallpaper into a live 3D globe with real-time weather, flights, and more — or a real-time astronomical sky dome showing the actual stars, planets, and moon above your location.

Built with MapboxGL, Swift, and WebKit. Entirely vibe-coded with Claude.

## Features

### Globe Map view
- **3D Globe** — Mapbox Standard style with faded theme, rendered as your desktop wallpaper
- **Day/Night Cycle** — real-time sun position with twilight and night overlays
- **Weather Radar** — live precipitation overlay via RainViewer (no API key needed)
- **Live Flights** — real-time aircraft positions from OpenSky Network
- **Pollen & Air Quality** — Google Pollen API + Open-Meteo air quality data
- **City Labels** — custom-styled country, state, city, and neighborhood labels
- **Globe Spin** — smooth auto-rotation (~40s per revolution)
- **Zoom Levels** — Globe, Country, City, and Street views
- **Search Location** — geocode any city/place and fly there
- **Menu Bar Controls** — toggle everything from the menu bar

### Live Sky view
- **Real-time sky dome** — Canvas2D renderer showing the sky as it actually looks above your location right now
- **Accurate sun & moon** — sun position accurate to ~0.01°; moon rendered with correct phase (crescent, gibbous, full) using lunar orbital mechanics
- **~120 named stars** — real RA/Dec coordinates for Sirius, Vega, Betelgeuse, Polaris, Orion's belt, Big Dipper and more, with spectral colour (blue-white through orange-red) and atmospheric twinkling
- **5 800 background stars** for a dense, realistic starfield
- **All 7 planets** — Mercury through Neptune via simplified VSOP orbital elements; colour-coded and sized by magnitude
- **Milky Way band** — rendered from galactic plane coordinates
- **Star & planet labels** — names drawn next to every visible named star (mag ≤ 2.0), all planets, the Moon, and the Sun; fade in with nightfall
- **Weather-driven sky** — cloud cover, rain, snow, and fog particles driven by live Open-Meteo data; sky gradient shifts from deep night through golden-hour twilight to full daytime blue
- **Switch views** — use the **"Live Sky"** pill button (bottom-right) or menu bar → **View: Live Sky / View: Globe Map**

## Requirements

- macOS 13.0+
- A free [Mapbox access token](https://account.mapbox.com/access-tokens/) (required)
- An [OpenSky Network](https://opensky-network.org/) account with an OAuth2 API client (required for live flights)
- A [Google Pollen API key](https://console.cloud.google.com/) (optional, for pollen data)

## Install

### From DMG

Download the latest DMG from [Releases](https://github.com/alexcohennyc/weather-wallpaper/releases), open it, and drag `WeatherWallpaper.app` to Applications.

### Build from source

```bash
git clone https://github.com/alexcohennyc/weather-wallpaper.git
cd weather-wallpaper
make run
```

Requires Xcode. If you only have **Xcode Command Line Tools** (no full Xcode.app), you can still compile and replace the binary manually:

```bash
# Install Command Line Tools if needed
xcode-select --install

# Compile all Swift sources directly into the pre-built app bundle
swiftc \
  WeatherWallpaper/main.swift \
  WeatherWallpaper/AppDelegate.swift \
  WeatherWallpaper/DesktopWindowManager.swift \
  WeatherWallpaper/LocationManager.swift \
  -o build/WeatherWallpaper.app/Contents/MacOS/WeatherWallpaper \
  -framework Cocoa \
  -framework WebKit \
  -framework CoreLocation \
  -framework ServiceManagement \
  -target arm64-apple-macosx13.0

open build/WeatherWallpaper.app
```

> **Note:** The compiled binary is not code-signed with a distribution certificate. macOS may show a Gatekeeper warning on first launch. Right-click the app → **Open** to bypass it, or run `xattr -cr build/WeatherWallpaper.app` to strip the quarantine flag.

## Setup

1. Launch the app — a globe icon appears in your menu bar
2. Click the icon → **Set Mapbox Token…** → paste your `pk.eyJ…` token
3. The globe renders on your desktop
4. To enable live flights: create a free account at [opensky-network.org](https://opensky-network.org), go to **My OpenSky → Account**, create an API client, then click **Set OpenSky Credentials…** in the menu and paste your `client_id` and `client_secret`

## Menu Bar

| Item | Description |
|------|-------------|
| Refresh Location | Re-detect current location via GPS |
| Search Location… | Geocode a city/place and fly there |
| Set Mapbox Token… | Enter your Mapbox public token |
| Set Pollen API Key… | Enter your Google Pollen API key |
| Set OpenSky Credentials… | Enter your OpenSky OAuth2 client ID and secret |
| View: Globe Map | Switch to the 3D globe wallpaper |
| View: Live Sky | Switch to the real-time astronomical sky dome |
| Zoom: Globe / Country / City / Street | Change zoom level (Globe view only) |
| Show Flights | Toggle live flight tracking (Globe view only) |
| Show Weather Radar | Toggle precipitation overlay (Globe view only) |
| Show Pollen & Air Quality | Toggle allergy view (Globe view only) |
| Show Labels | Toggle map labels (Globe view only) |
| Spin Globe | Smooth auto-rotation (Globe view only) |
| Launch at Login | Start on boot |

## APIs Used

- [Mapbox GL JS](https://www.mapbox.com/) — 3D globe rendering
- [OpenSky Network](https://opensky-network.org/) — live flight data (fetched via Swift `URLSession` to avoid WKWebView CORS restrictions; requires OAuth2 credentials)
- [RainViewer](https://www.rainviewer.com/api.html) — weather radar tiles (free, no key)
- [Open-Meteo](https://open-meteo.com/) — weather data for both views: current conditions, cloud cover, precipitation, visibility, forecasts (free, no key)
- [Google Pollen API](https://developers.google.com/maps/documentation/pollen) — pollen forecasts

## Sky View – technical notes

The Live Sky view requires no API keys. All astronomy is computed locally in JavaScript:

- **Sun** — low-disturbance solar theory, accurate to ~0.01°
- **Moon** — ELP2000 simplified series (major terms), correct phase rendering
- **Planets** — simplified VSOP87 orbital elements for Mercury–Neptune
- **Stars** — 120 named stars from the Bright Star Catalogue + 5 800 procedural background stars; spectral colour from B-V index
- **Coordinate transform** — RA/Dec → Alt/Az via GMST + hour angle, correct for observer latitude/longitude
- Weather effects (clouds, rain, snow, fog) update every 12 minutes from Open-Meteo

## License

MIT
