# TripMate
It's a website that'll show you hidden sidequests in your journey route that you can add on the route to explore it which'll eventually improve the trip experince
TripMate AI

TripMate AI is a browser-based trip planner for building a route, discovering places along the way, and turning selected stops into a day-by-day itinerary. Its “side quests” are real places found in OpenStreetMap data; Gemini can explain schedule trade-offs and rank stops using the trip details supplied by the app.

> **Map provider note:** This project currently uses Leaflet and OpenStreetMap services. It does not use the Google Maps API.

## Features

- Search for and select a trip origin and destination.
- Build a driving route with optional stops and view its distance and estimated duration.
- Discover places along all or part of the route, using a 5 km, 10 km, or 20 km corridor radius.
- Filter discoveries by category, including attractions, viewpoints, historic sites, nature, temples, food, markets, and museums.
- Review a suggested stop’s estimated detour and add it to or remove it from the trip.
- Create a day-by-day schedule using trip length, start time, daily driving limit, and estimated stop durations.
- Simulate a delay and see how it affects the schedule.
- Ask Gemini to explain schedule trade-offs and rank the stops. If Gemini is not configured or its request fails, the server returns a local heuristic analysis instead.
- Search for places and landmarks from the map interface.

## Technology and external services

- **Frontend:** HTML, CSS, and vanilla JavaScript
- **Map display:** Leaflet with OpenStreetMap map tiles
- **Place search / geocoding:** Nominatim (OpenStreetMap)
- **Route and detour estimates:** OSRM public routing service
- **Side-quest place data:** Overpass API (OpenStreetMap), with a backend proxy and client-side fallback
- **AI schedule commentary:** Gemini API, called through the Flask backend
- **Backend:** Python and Flask

These public services have their own usage policies, availability limits, and attribution requirements. Check their current terms before deploying the app or serving substantial traffic.

## Requirements

- Python 3.9 or newer
- Internet access for the map tiles and external geocoding, routing, place-search, and optional Gemini services
- A Gemini API key only if you want AI-generated schedule commentary; local heuristic commentary works without one

## Setup

Open a terminal in the project folder and install the Python dependencies:

```bash
python -m pip install Flask python-dotenv
```

Create a `.env` file in the project folder if you want to enable Gemini. Add your own key:

```dotenv
GEMINI_API_KEY=your_gemini_api_key
```

Keep `.env` private. It is excluded by the provided `.gitignore`; do not commit or share a real API key.

Start the app:

```bash
python server.py
```

Then open [http://127.0.0.1:5000](http://127.0.0.1:5000) in your browser. Use the Flask server rather than opening `index.html` directly, because the frontend calls backend endpoints for Gemini and the Overpass proxy.

## How to use

1. Enter an origin and destination, search for each, and select the correct result.
2. Set trip days, start time, daily time limit, and interests.
3. Build the route. Add any stops you already want to visit.
4. Open **Side Quests**, choose a route section, radius, and category, then discover places.
5. Review the place cards and detour estimates. Add interesting stops to the trip.
6. Open **Itinerary** to review the schedule. Enter a delay and recalculate to simulate its effect.
7. Use the Gemini analysis action for an explanation and stop priorities. Without a configured Gemini key, the app uses its built-in heuristic fallback.

## Project files

| File | Purpose |
| --- | --- |
| `server.py` | Flask server, static file serving, Gemini endpoint, and Overpass proxy |
| `index.html` | App structure and interface |
| `style.css` | Layout, visual styles, and responsive behavior |
| `script.js` | Map, trip state, route planning, side-quest discovery, search, and itinerary logic |
| `.gitignore` | Excludes environment secrets and Python cache files from Git |

## Backend endpoints

- `GET /` serves the web app.
- `GET /api/config` reports whether a Gemini key is configured; it does not return the key.
- `POST /api/gemini/explain` analyzes the submitted trip, stops, itinerary, and delay information. It returns Gemini commentary when available and a heuristic fallback otherwise.
- `POST /api/overpass` forwards a place query to an Overpass endpoint and tries a backup endpoint if needed.

## Important limitations

- Route times, visit durations, and detour calculations are estimates from public services; actual conditions can differ.
- Place data may be incomplete, outdated, or unavailable. Confirm opening hours, access, and suitability before traveling.
- Gemini commentary is advisory. The server prompt instructs Gemini to use only supplied trip data, but generated text should still be treated as AI output rather than verified travel information.
- The app’s 20 km setting is a **search radius from the selected route section**, not a guarantee that the stop adds at most 20 km of driving. Review the displayed detour estimate before adding a stop.
- The project uses public/demo infrastructure for several services. A production deployment should review provider policies, add suitable monitoring and rate controls, and use service credentials and restrictions appropriate to the deployment.

## Troubleshooting

- **Gemini commentary is unavailable:** Confirm that `.env` is beside `server.py`, the variable is named `GEMINI_API_KEY`, and the server was restarted after editing it. Without a valid key, heuristic commentary is expected.
- **No route appears:** Check that both endpoints were selected from the search results and that the OSRM service is reachable.
- **No side quests appear:** Try another route section or category, increase the search radius, or retry later. Public Overpass services can be busy or rate-limited.
- **The page is blank or API requests fail:** Start the app with `python server.py` and visit `http://127.0.0.1:5000`; do not launch the HTML file directly.
