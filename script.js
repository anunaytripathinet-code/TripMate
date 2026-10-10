// ====================================================
// TripMate AI – script.js
// Complete Engine: Route Corridor Side Quests & Reference UI
// ====================================================

// ─── Map & Layer State ────────────────────────────────
let map               = null;
let routePolylineLayer = null;
let routeMarkers      = [];   // Waypoint markers on map
let searchMarkers     = [];   // Nominatim search results
let sqMarkers         = [];   // Side quest suggestion markers
let originMapMarker   = null;
let destMapMarker     = null;

// ─── Trip Configuration ───────────────────────────────
let tripConfig = {
    origin:          null,
    originCoords:    null,   // { lat, lon }
    destination:     null,
    destCoords:      null,   // { lat, lon }
    days:            1,
    startTime:       '09:00',
    dailyLimitHours: 8,
    interests:       'Nature, Temples, Photography, Cafes, Forts'
};

// Route stops list: [{ id, name, lat, lon, type, durationMins, category, sqId }]
let tripStops = [];

// Base route & detour tracking
let currentRouteData    = null;   // OSRM route object
let currentRouteGeom    = null;   // [[lon, lat], ...] from OSRM GeoJSON
let currentRouteDistKm  = 0;      // Total km of active route
let currentRouteDurMin  = 0;      // Total minutes of active route
let previousRouteDistKm = 0;      // For detour comparison
let previousRouteDurMin = 0;
let currentSchedule     = [];
let currentDelayMinutes = 0;

// Side Quests State
let sideQuestResults   = [];
let sqAddedIds         = new Set();
let sqDetourData       = {};     // sqId -> { extraDistKm, extraDurMin }
let sqFetchInProgress  = false;
let sqCachedKey        = null;   // Active cache key
let sqSectionCache     = new Map(); // Detailed cache: key -> results array

// Public API Mirrors & Rate Limiting (Single proxy with 1 fallback, never parallel)
const OVERPASS_ENDPOINTS = [
    '/api/overpass',                                // Backend resilient proxy (tries primary then fallback with backoff)
    'https://lz4.overpass-api.de/api/interpreter'  // Standalone client fallback if backend is unreachable
];
const MAX_SQ_RESULTS     = 30;
let lastNominatimTs      = 0;
const NOMINATIM_MIN_MS   = 1050;

// Category styling metadata (aligned with reference UI photo3)
const SQ_CATEGORIES = {
    viewpoint:  { label: 'Viewpoint',    icon: '⛰️', color: '#0284c7', light: '#e0f2fe' },
    attraction: { label: 'Attraction',   icon: '🎡', color: '#7c3aed', light: '#ede9fe' },
    historic:   { label: 'Historic Site',icon: '🏰', color: '#b45309', light: '#fef3c7' },
    nature:     { label: 'Nature Spot',  icon: '🌲', color: '#2d6a4f', light: '#d8f3dc' },
    waterfall:  { label: 'Waterfall',    icon: '🌊', color: '#0891b2', light: '#cffafe' },
    temple:     { label: 'Temple',       icon: '🛕', color: '#6d28d9', light: '#ede9fe' },
    cafe:       { label: 'Café & Food',  icon: '☕', color: '#d97706', light: '#fef9c3' },
    market:     { label: 'Local Market', icon: '🛍️', color: '#dc2626', light: '#fee2e2' },
    museum:     { label: 'Museum',       icon: '🏛️', color: '#4f46e5', light: '#e0e7ff' },
    other:      { label: 'Scenic Spot',  icon: '📍', color: '#40916c', light: '#eaf5ee' }
};

// =====================================================
// 1. INITIALIZATION
// =====================================================
document.addEventListener('DOMContentLoaded', () => {
    // Initialize Leaflet Map centered over India default
    map = L.map('map', { center: [28.6139, 77.2090], zoom: 6, zoomControl: true });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
        maxZoom: 19
    }).addTo(map);

    // Setup Components
    checkGeminiConfig();
    setupNavigationTabs();
    setupTripInputs();
    setupPlacesSearchUI();
    setupDelayAndAiUI();
    setupSideQuestsUI();
    setupFeaturedCardUI();
    renderStopsList();
    updateHeaderStats();
});

// =====================================================
// 2. NAVIGATION TABS (Left Rail)
// =====================================================
function setupNavigationTabs() {
    const railBtns = document.querySelectorAll('.rail-btn');
    const contents = document.querySelectorAll('.tab-content');

    railBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            railBtns.forEach(b => {
                b.classList.remove('active');
                b.setAttribute('aria-selected', 'false');
            });
            contents.forEach(c => c.classList.remove('active'));

            btn.classList.add('active');
            btn.setAttribute('aria-selected', 'true');

            const targetId = btn.getAttribute('data-tab');
            const targetEl = document.getElementById(targetId);
            if (targetEl) targetEl.classList.add('active');

            // Trigger Leaflet map resize calculation
            if (map) setTimeout(() => map.invalidateSize(), 150);
        });
    });
}

function switchToTab(tabId) {
    const btn = document.querySelector(`.rail-btn[data-tab="${tabId}"]`);
    if (btn) btn.click();
}

// =====================================================
// 3. ENDPOINT PICKERS (Nominatim Explicit Selection)
// =====================================================
function setupTripInputs() {
    setupEndpointPicker('origin', 'tripOriginInput', 'originSearchBtn',
        'originStatus', 'originStatusText', 'originResultsList');
    setupEndpointPicker('dest', 'tripDestInput', 'destSearchBtn',
        'destStatus', 'destStatusText', 'destResultsList');

    const bindInput = (id, key, transform) => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', () => {
                tripConfig[key] = transform(el.value);
                updateHeaderStats();
            });
        }
    };

    bindInput('tripDaysInput',       'days',            v => Math.max(1, parseInt(v) || 1));
    bindInput('tripStartTimeInput',  'startTime',       v => v || '09:00');
    bindInput('tripDailyLimitInput', 'dailyLimitHours', v => parseFloat(v) || 8);
    bindInput('tripInterestsInput',  'interests',       v => v.trim());

    const presetBtn = document.getElementById('addPresetStopsBtn');
    if (presetBtn) presetBtn.addEventListener('click', loadSampleStops);

    const buildBtn = document.getElementById('buildRouteBtn');
    if (buildBtn) buildBtn.addEventListener('click', calculateMultiStopRouteAndSchedule);
}

function setupEndpointPicker(role, inputId, searchBtnId, statusId, statusTextId, listId) {
    const input      = document.getElementById(inputId);
    const searchBtn  = document.getElementById(searchBtnId);
    const statusDiv  = document.getElementById(statusId);
    const statusText = document.getElementById(statusTextId);
    const list       = document.getElementById(listId);
    if (!input || !searchBtn) return;

    input.addEventListener('input', () => {
        if (role === 'origin') {
            tripConfig.originCoords = null;
            tripConfig.origin       = null;
            removeEndpointMarker('origin');
        } else {
            tripConfig.destCoords   = null;
            tripConfig.destination  = null;
            removeEndpointMarker('dest');
        }
        setEndpointStatus(statusDiv, statusText, false, 'Search and select to confirm.');
        if (list) list.style.display = 'none';
        sqCachedKey = null;
        updateHeaderStats();
    });

    const triggerSearch = () => searchEndpointNominatim(role, input, statusDiv, statusText, list);
    searchBtn.addEventListener('click', triggerSearch);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') triggerSearch(); });
}

async function searchEndpointNominatim(role, input, statusDiv, statusText, list) {
    const query = input.value.trim();
    if (!query) {
        setEndpointStatus(statusDiv, statusText, false, 'Type a place name first.');
        return;
    }

    setEndpointStatus(statusDiv, statusText, false, 'Searching OpenStreetMap…');
    if (list) { list.innerHTML = ''; list.style.display = 'none'; }

    // Rate-limit Nominatim to 1 request per 1050ms
    const wait = NOMINATIM_MIN_MS - (Date.now() - lastNominatimTs);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastNominatimTs = Date.now();

    try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&addressdetails=1&limit=6`;
        const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        if (!data || !data.length) {
            setEndpointStatus(statusDiv, statusText, false, `No results for "${query}". Try adding region (e.g. "Etawah, UP" or "Leh, Ladakh").`);
            return;
        }

        populateEndpointDropdown(role, data, list, statusDiv, statusText, input);
    } catch (err) {
        console.error('Nominatim search error:', err);
        setEndpointStatus(statusDiv, statusText, false, 'Network error. Please try again.');
    }
}

function populateEndpointDropdown(role, places, list, statusDiv, statusText, input) {
    list.innerHTML = '';
    list.style.display = 'flex';

    places.forEach(place => {
        const lat = parseFloat(place.lat);
        const lon = parseFloat(place.lon);
        if (isNaN(lat) || isNaN(lon)) return;

        const parts     = place.display_name.split(',');
        const shortName = parts[0].trim();
        const region    = parts.slice(1, 4).join(',').trim();

        const li = document.createElement('li');
        li.className = 'endpoint-result-item';
        li.innerHTML = `
            <div class="ep-name">${escapeHtml(shortName)}</div>
            <div class="ep-region">${escapeHtml(region || place.display_name)}</div>
        `;

        li.addEventListener('click', () => {
            input.value = shortName;
            list.style.display = 'none';
            setEndpointStatus(statusDiv, statusText, true, `✓ ${shortName} (${lat.toFixed(4)}°, ${lon.toFixed(4)}°)`);

            if (role === 'origin') {
                tripConfig.origin = shortName;
                tripConfig.originCoords = { lat, lon };
                placeEndpointMarker('origin', lat, lon, shortName);
            } else {
                tripConfig.destination = shortName;
                tripConfig.destCoords  = { lat, lon };
                placeEndpointMarker('dest', lat, lon, shortName);
            }
            sqCachedKey = null;
            updateHeaderStats();
        });

        list.appendChild(li);
    });

    setEndpointStatus(statusDiv, statusText, false, `${places.length} result(s) – click the correct one to confirm.`);
}

function setEndpointStatus(statusDiv, statusTextEl, ok, msg) {
    if (!statusDiv || !statusTextEl) return;
    const icon = statusDiv.querySelector('.status-icon');
    if (icon) {
        icon.textContent = ok ? '✓' : '⚠';
        icon.className   = `status-icon ${ok ? 'ok' : 'warn'}`;
    }
    statusTextEl.textContent = msg;
    statusTextEl.className   = `status-text${ok ? ' confirmed' : ''}`;
}

function placeEndpointMarker(role, lat, lon, name) {
    removeEndpointMarker(role);
    const isOrigin = role === 'origin';
    const color    = isOrigin ? '#1b4332' : '#d97706';
    const label    = isOrigin ? 'Start (A)' : 'End (B)';

    const marker = L.circleMarker([lat, lon], {
        radius: 10,
        fillColor: color,
        color: '#ffffff',
        weight: 3,
        opacity: 1,
        fillOpacity: 1
    }).addTo(map);

    marker.bindPopup(`<b>${label}:</b> ${escapeHtml(name)}<br><small>${lat.toFixed(4)}°, ${lon.toFixed(4)}°</small>`);
    marker.openPopup();

    if (isOrigin) originMapMarker = marker;
    else destMapMarker = marker;

    fitEndpointBounds();
}

function removeEndpointMarker(role) {
    if (role === 'origin' && originMapMarker) {
        map.removeLayer(originMapMarker);
        originMapMarker = null;
    }
    if (role === 'dest' && destMapMarker) {
        map.removeLayer(destMapMarker);
        destMapMarker = null;
    }
}

function fitEndpointBounds() {
    const pts = [];
    if (originMapMarker) pts.push(originMapMarker.getLatLng());
    if (destMapMarker)   pts.push(destMapMarker.getLatLng());
    if (pts.length === 2) map.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 13 });
    else if (pts.length === 1) map.setView(pts[0], 11);
}

// =====================================================
// 4. PRESET STOPS
// =====================================================
function loadSampleStops() {
    tripStops = [
        { id: 'sample-1', name: 'Taj Mahal', lat: 27.1751, lon: 78.0421, type: 'must_visit', durationMins: 90, category: 'Historic Site' },
        { id: 'sample-2', name: 'Kurukshetra Panorama', lat: 29.9658, lon: 76.8334, type: 'optional', durationMins: 60, category: 'Museum' },
        { id: 'sample-3', name: 'Rewalsar Lake', lat: 31.6325, lon: 76.8333, type: 'optional', durationMins: 60, category: 'Nature Spot' }
    ];
    renderStopsList();
    updateHeaderStats();
}

// =====================================================
// 5. STOPS MANAGER
// =====================================================
function renderStopsList() {
    const listEl  = document.getElementById('selectedStopsList');
    const notice  = document.getElementById('stopsEmptyNotice');
    const countEl = document.getElementById('stopsCount');
    if (!listEl) return;

    listEl.innerHTML = '';
    if (countEl) countEl.textContent = tripStops.length;
    if (notice) notice.style.display = tripStops.length === 0 ? 'block' : 'none';

    tripStops.forEach((stop, idx) => {
        const isMust = stop.type === 'must_visit';
        const li = document.createElement('li');
        li.className = 'stop-item';
        li.innerHTML = `
            <div class="stop-index-badge">${idx + 1}</div>
            <div class="stop-info">
                <div class="stop-name" title="${escapeHtml(stop.name)}">${escapeHtml(stop.name)}</div>
                <div class="stop-controls">
                    <button class="type-toggle-pill ${isMust ? 'must-visit' : 'optional'}">
                        ${isMust ? '★ Must-Visit' : '○ Optional'}
                    </button>
                    <div class="duration-control">
                        <span>Visit:</span>
                        <input class="duration-input" type="number" min="15" max="360"
                               step="15" value="${stop.durationMins}" aria-label="Visit duration">
                        <span>min</span>
                    </div>
                </div>
            </div>
            <button class="remove-stop-btn" title="Remove stop" aria-label="Remove ${escapeHtml(stop.name)}">✕</button>
        `;

        li.querySelector('.type-toggle-pill').addEventListener('click', () => {
            stop.type = stop.type === 'must_visit' ? 'optional' : 'must_visit';
            renderStopsList();
        });

        li.querySelector('.duration-input').addEventListener('change', e => {
            stop.durationMins = Math.max(15, parseInt(e.target.value) || 30);
        });

        li.querySelector('.remove-stop-btn').addEventListener('click', () => {
            removeStopByIndex(idx);
        });

        listEl.appendChild(li);
    });

    updateHeaderStats();
}

function removeStopByIndex(idx) {
    const removed = tripStops.splice(idx, 1)[0];
    if (removed && removed.sqId) {
        sqAddedIds.delete(removed.sqId);
        delete sqDetourData[removed.sqId];
    }
    renderStopsList();
    refreshSqCardsState();

    if (tripConfig.originCoords && tripConfig.destCoords && currentRouteData) {
        calculateMultiStopRouteAndSchedule();
    }
}

function addStop(stop) {
    tripStops.push(stop);
    renderStopsList();
}

// =====================================================
// 6. OSRM MULTI-STOP ROUTING & ITINERARY
// =====================================================
async function calculateMultiStopRouteAndSchedule() {
    if (!tripConfig.originCoords) {
        alert('Please search and select your Origin first in the Plan tab.');
        switchToTab('tab-plan');
        return;
    }
    if (!tripConfig.destCoords) {
        alert('Please search and select your Destination first in the Plan tab.');
        switchToTab('tab-plan');
        return;
    }

    const buildBtn = document.getElementById('buildRouteBtn');
    if (buildBtn) {
        buildBtn.disabled = true;
        buildBtn.textContent = 'Calculating Route…';
    }

    const waypoints = [
        { name: tripConfig.origin,      lat: tripConfig.originCoords.lat, lon: tripConfig.originCoords.lon, isEndpoint: true },
        ...tripStops,
        { name: tripConfig.destination, lat: tripConfig.destCoords.lat,   lon: tripConfig.destCoords.lon,   isEndpoint: true }
    ];

    // Haversine straight-line check to detect snapping anomalies
    const straightKm = haversineKm(
        tripConfig.originCoords.lat, tripConfig.originCoords.lon,
        tripConfig.destCoords.lat,   tripConfig.destCoords.lon
    );

    // OSRM GeoJSON format takes [longitude, latitude]
    const coordStr = waypoints.map(w => `${w.lon},${w.lat}`).join(';');
    const osrmUrl  = `https://router.project-osrm.org/route/v1/driving/${coordStr}?overview=full&geometries=geojson`;

    try {
        const res = await fetch(osrmUrl);
        if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
        const data = await res.json();

        if (data.code !== 'Ok' || !data.routes?.length) {
            alert('OSRM could not find a driving route between these points. Some locations may be unreachable by road.');
            return;
        }

        const route       = data.routes[0];
        const routeDistKm = route.distance / 1000;

        // Sanity check: if routed distance is < 50% straight-line distance, reject
        if (straightKm > 5 && routeDistKm < straightKm * 0.5) {
            alert(
                `Route sanity check failed.\n\n` +
                `Straight-line distance: ${straightKm.toFixed(1)} km\n` +
                `OSRM returned: ${routeDistKm.toFixed(1)} km\n\n` +
                `The routed distance is unusually small. Please verify origin and destination selections.`
            );
            return;
        }

        previousRouteDistKm = currentRouteDistKm;
        previousRouteDurMin = currentRouteDurMin;
        currentRouteData    = route;
        currentRouteGeom    = route.geometry.coordinates; // [[lon, lat], ...]
        currentRouteDistKm  = routeDistKm;
        currentRouteDurMin  = Math.round(route.duration / 60);

        // Invalidate Side Quest cache if route endpoints changed
        const currentCoordKey = `${tripConfig.originCoords.lat.toFixed(4)},${tripConfig.originCoords.lon.toFixed(4)}->${tripConfig.destCoords.lat.toFixed(4)},${tripConfig.destCoords.lon.toFixed(4)}`;
        if (sqCachedKey && !sqCachedKey.startsWith(currentCoordKey)) {
            sqCachedKey = null;
        }

        // Enable Side Quests discovery button
        const discBtn = document.getElementById('discoverSideQuestsBtn');
        if (discBtn) discBtn.disabled = false;

        renderRouteOnMap(route, waypoints);
        updateRouteOverviewUI(route, waypoints);
        generateDayByDaySchedule(route.legs, waypoints, 0);
        updateHeaderStats();

        // Trigger Gemini AI trade-off analysis
        requestGeminiExplanation();

    } catch (err) {
        console.error('Route calculation error:', err);
        alert('Could not compute driving route via OSRM. Please check your internet connection.');
    } finally {
        if (buildBtn) {
            buildBtn.disabled = false;
            buildBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                </svg>
                Calculate Route &amp; Build Itinerary
            `;
        }
    }
}

function renderRouteOnMap(route, waypoints) {
    if (routePolylineLayer) {
        map.removeLayer(routePolylineLayer);
        routePolylineLayer = null;
    }
    routeMarkers.forEach(m => map.removeLayer(m));
    routeMarkers = [];

    // Draw high-contrast route polyline matching UI reference
    routePolylineLayer = L.geoJSON(route.geometry, {
        style: {
            color: '#1b4332',
            weight: 5,
            opacity: 0.88,
            lineJoin: 'round'
        }
    }).addTo(map);

    map.fitBounds(routePolylineLayer.getBounds(), { padding: [50, 50] });

    // Place waypoint markers along the route
    waypoints.forEach((wp, i) => {
        const isStart = i === 0;
        const isEnd   = i === waypoints.length - 1;
        const color   = isStart ? '#1b4332' : (isEnd ? '#d97706' : '#2d6a4f');

        const marker = L.circleMarker([wp.lat, wp.lon], {
            radius: isStart || isEnd ? 10 : 8,
            fillColor: color,
            color: '#ffffff',
            weight: 2.5,
            opacity: 1,
            fillOpacity: 1
        }).addTo(map);

        marker.bindPopup(`<b>${escapeHtml(wp.name)}</b><br><small>${wp.category || (isStart ? 'Origin' : (isEnd ? 'Destination' : 'Stop'))}</small>`);
        routeMarkers.push(marker);
    });
}

function updateRouteOverviewUI(route, waypoints) {
    const card = document.getElementById('routeOverviewCard');
    if (!card) return;
    card.style.display = 'block';

    const distEl  = document.getElementById('totalRouteDistance');
    const durEl   = document.getElementById('totalRouteDuration');
    const stopsEl = document.getElementById('totalStopsMetric');
    const legsEl  = document.getElementById('legsBreakdownContainer');

    if (distEl)  distEl.textContent  = `${(route.distance / 1000).toFixed(1)} km`;
    if (durEl)   durEl.textContent   = formatDuration(Math.round(route.duration / 60));
    if (stopsEl) stopsEl.textContent = `${tripStops.length} stops`;

    if (legsEl && route.legs) {
        legsEl.innerHTML = '';
        route.legs.forEach((leg, i) => {
            const fromName = waypoints[i]?.name || `Point ${i + 1}`;
            const toName   = waypoints[i + 1]?.name || `Point ${i + 2}`;
            const legDist  = (leg.distance / 1000).toFixed(1);
            const legDur   = Math.round(leg.duration / 60);

            const row = document.createElement('div');
            row.className = 'leg-row';
            row.innerHTML = `<strong>${escapeHtml(fromName)}</strong> → <strong>${escapeHtml(toName)}</strong>: ${legDist} km · ~${legDur} min`;
            legsEl.appendChild(row);
        });
    }
}

// =====================================================
// 7. SIDE QUESTS DISCOVERY (Corridor Overpass Engine)
// =====================================================
function setupSideQuestsUI() {
    const discBtn   = document.getElementById('discoverSideQuestsBtn');
    const retryBtn  = document.getElementById('sqRetryBtn');
    const filterEl  = document.getElementById('sqInterestFilter');
    const sectionEl = document.getElementById('sqSectionSelector');
    const hintEl    = document.getElementById('sqRadiusHint');

    if (discBtn) {
        discBtn.addEventListener('click', () => {
            if (!currentRouteGeom || !currentRouteGeom.length) {
                showSqStatus('Please calculate a route first in the Plan tab.', 'warn');
                return;
            }
            discoverSideQuests();
        });
    }

    if (retryBtn) {
        retryBtn.addEventListener('click', () => {
            if (currentRouteGeom && currentRouteGeom.length) {
                discoverSideQuests(true); // Force retry
            }
        });
    }

    if (filterEl) {
        filterEl.addEventListener('change', () => {
            if (sideQuestResults.length) renderSqResults(sideQuestResults);
        });
    }

    if (sectionEl) {
        sectionEl.addEventListener('change', () => {
            const val = sectionEl.value;
            const hint = document.getElementById('sqSectionHint');
            if (hint) {
                if (val === 'section-1') hint.textContent = 'Early journey (first leg)';
                else if (val === 'section-2') hint.textContent = 'Mid-journey (core corridor)';
                else if (val === 'section-3') hint.textContent = 'Destination approach';
                else hint.textContent = 'Balanced samples';
            }
            // Check if section is cached
            const cacheKey = getSqCacheKey();
            if (sqSectionCache.has(cacheKey)) {
                const cached = sqSectionCache.get(cacheKey);
                sideQuestResults = cached;
                renderSqResults(cached);
                placeSqMarkersOnMap(cached);
                showSqStatus(`Loaded ${cached.length} cached places for this section.`, 'ok');
            }
        });
    }

    // Radius Radio Selector (5 km, 10 km, 20 km)
    document.querySelectorAll('input[name="sqRadius"]').forEach(radio => {
        radio.addEventListener('change', () => {
            const km = parseInt(radio.value) / 1000;
            if (hintEl) hintEl.textContent = `${km} km off-road`;
            if (currentRouteGeom) {
                const discBtn = document.getElementById('discoverSideQuestsBtn');
                if (discBtn) discBtn.disabled = false;
            }
        });
    });
}

function getSelectedRadius() {
    const radios = document.querySelectorAll('input[name="sqRadius"]');
    for (const r of radios) {
        if (r.checked) return parseInt(r.value);
    }
    return 10000; // default 10,000 meters (10 km)
}

function getSqCacheKey() {
    if (!currentRouteGeom || !currentRouteGeom.length) return '';
    const radiusM   = getSelectedRadius();
    const filterCat = (document.getElementById('sqInterestFilter')?.value || '').trim();
    const section   = (document.getElementById('sqSectionSelector')?.value || 'section-2').trim();
    const routeId   = `${tripConfig.origin || ''}->${tripConfig.destination || ''}:${currentRouteGeom.length}`;
    return `${routeId}|${section}|${radiusM}|${filterCat}`;
}

async function discoverSideQuests(isRetry = false) {
    if (sqFetchInProgress) return;
    if (!currentRouteGeom || !currentRouteGeom.length) return;

    const radiusM   = getSelectedRadius();
    const radiusKm  = radiusM / 1000;
    const filterCat = (document.getElementById('sqInterestFilter')?.value || '').trim();
    const section   = (document.getElementById('sqSectionSelector')?.value || 'section-2').trim();
    const cacheKey  = getSqCacheKey();

    // 1. Check Section Cache (avoid repeated network requests entirely)
    if (!isRetry && sqSectionCache.has(cacheKey)) {
        const cached = sqSectionCache.get(cacheKey);
        sideQuestResults = cached;
        sqCachedKey      = cacheKey;
        renderSqResults(cached);
        placeSqMarkersOnMap(cached);
        showSqStatus(`Showing ${cached.length} cached place(s) within ${radiusKm} km off-road.`, 'ok');
        const badge = document.getElementById('sqBadge');
        if (badge) { badge.textContent = cached.length; badge.style.display = 'block'; }
        return;
    }

    sqFetchInProgress = true;

    const discBtn  = document.getElementById('discoverSideQuestsBtn');
    const retryBtn = document.getElementById('sqRetryBtn');
    const spinner  = document.getElementById('sqLoadingSpinner');
    const resList  = document.getElementById('sqResultsList');
    const notice   = document.getElementById('sqEmptyNotice');

    if (discBtn) { discBtn.disabled = true; discBtn.textContent = 'Searching Section…'; }
    if (retryBtn) retryBtn.style.display = 'none';
    if (spinner) spinner.style.display = 'flex';
    if (resList) resList.style.display = 'none';
    if (notice)  notice.style.display  = 'none';

    showSqStatus(`Querying real OpenStreetMap corridor places (${radiusKm} km radius)…`, 'info');

    // 2. Select at most 1 to 2 targeted corridor center-points based on chosen section
    // Keep queries small, fast, and bounded to prevent timeouts!
    const geom = currentRouteGeom;
    const totalPts = geom.length;
    let sampleIdxs = [];

    if (section === 'section-1') {
        sampleIdxs = [Math.floor(totalPts * 0.20)];
    } else if (section === 'section-3') {
        sampleIdxs = [Math.floor(totalPts * 0.80)];
    } else if (section === 'all') {
        // Balanced sample (2 points maximum)
        sampleIdxs = [Math.floor(totalPts * 0.35), Math.floor(totalPts * 0.70)];
    } else {
        // section-2 (Mid-journey core): default 1 focused central waypoint
        sampleIdxs = [Math.floor(totalPts * 0.50)];
    }

    const samplePts = sampleIdxs.map(idx => {
        const [lon, lat] = geom[idx]; // OSRM GeoJSON is [lon, lat]
        return { lat, lon };
    });

    console.info('[TripMate Overpass Diagnostic] Single-section bounded query:', {
        section,
        samplePointsCount: samplePts.length,
        radiusMeters: radiusM,
        filterCategory: filterCat || 'All',
        points: samplePts.map(p => `lat=${p.lat.toFixed(4)}, lon=${p.lon.toFixed(4)}`)
    });

    // 3. Issue single, bounded Overpass requests sequentially (never parallel flooding)
    let rawElements = [];
    let queryError = null;

    for (let i = 0; i < samplePts.length; i++) {
        const pt = samplePts[i];
        if (i > 0) await new Promise(r => setTimeout(r, 600)); // Respectful polite delay

        const res = await queryOverpassSingleBounded(pt.lat, pt.lon, radiusM, filterCat);
        if (res.ok) {
            rawElements = rawElements.concat(res.elements || []);
        } else {
            queryError = res;
            console.warn(`[TripMate Overpass] Section query point ${i + 1} failed:`, res.error);
        }
    }

    if (spinner) spinner.style.display = 'none';
    sqFetchInProgress = false;
    resetDiscoverBtn(discBtn);

    // 4. Handle Service Failures transparently with Retry capability
    if (!rawElements.length && queryError) {
        if (retryBtn) retryBtn.style.display = 'inline-flex';

        const status = queryError.status;
        const msg    = queryError.error || 'Server error';

        if (status === 429) {
            showSqStatus('OpenStreetMap Overpass is rate-limited (HTTP 429). Please click Retry in a few seconds.', 'warn');
        } else if (status === 504 || status === 502 || msg.includes('Timeout') || msg.includes('timed out')) {
            showSqStatus('Public OpenStreetMap servers timed out (HTTP 504). Click Retry to request via backup mirror.', 'warn');
        } else {
            showSqStatus(`Overpass error: ${msg}. Click Retry to try again.`, 'warn');
        }

        // Preserve previously loaded results rather than wiping them out!
        if (sideQuestResults.length) {
            renderSqResults(sideQuestResults);
            placeSqMarkersOnMap(sideQuestResults);
        } else if (notice) {
            notice.textContent = `Search failed (${msg}). Please click Retry.`;
            notice.style.display = 'block';
        }
        return;
    }

    // 5. Genuine Empty Result (Server succeeded with 0 items)
    if (!rawElements.length) {
        showSqStatus(`No notable places found within ${radiusKm} km for this section. Try increasing the radius to 20 km or choosing another section.`, 'warn');
        if (notice) {
            notice.textContent = `No places found within ${radiusKm} km in this route section.`;
            notice.style.display = 'block';
        }
        return;
    }

    // 6. Process, parse way/relation centers, and deduplicate real OpenStreetMap places
    const seenIds = new Set();
    const results = [];

    rawElements.forEach(el => {
        const osmId = el.id;
        if (!osmId || seenIds.has(osmId)) return;
        seenIds.add(osmId);

        const tags = el.tags || {};
        const name = tags.name || tags['name:en'] || null;
        if (!name) return; // Ignore unnamed features

        // Support both node lat/lon and polygon center lat/lon
        const lat = el.lat != null ? el.lat : (el.center ? el.center.lat : null);
        const lon = el.lon != null ? el.lon : (el.center ? el.center.lon : null);
        if (lat == null || lon == null) return;

        const category = sqCategoryFor(tags);
        const region   = [tags['addr:city'], tags['addr:state'], tags['addr:country']].filter(Boolean).join(', ') || '';
        const distKm   = distToRouteKm(lat, lon);

        results.push({
            id:              `osm-${el.type || 'node'}-${osmId}`,
            osmId:           osmId,
            osmType:         el.type || 'node',
            name:            name,
            lat:             lat,
            lon:             lon,
            category:        category,
            region:          region,
            tags:            tags,
            dayIdx:          0,
            durationMins:    defaultDuration(category),
            distFromRouteKm: distKm,
            interestScore:   0
        });
    });

    // Rank matching traveler interests, then closest to corridor
    const interests = tripConfig.interests.toLowerCase().split(',').map(s => s.trim());
    results.forEach(r => {
        const text = `${r.category} ${r.name} ${Object.values(r.tags).join(' ')}`.toLowerCase();
        r.interestScore = interests.reduce((acc, term) => acc + (text.includes(term) ? 3 : 0), 0);
    });

    results.sort((a, b) =>
        b.interestScore - a.interestScore ||
        (a.distFromRouteKm || 0) - (b.distFromRouteKm || 0)
    );

    const finalResults = results.slice(0, MAX_SQ_RESULTS);
    sideQuestResults   = finalResults;
    sqCachedKey        = cacheKey;
    sqSectionCache.set(cacheKey, finalResults);

    clearSqMarkers();
    renderSqResults(finalResults);
    placeSqMarkersOnMap(finalResults);

    const cnt = finalResults.length;
    showSqStatus(`Found ${cnt} real place${cnt !== 1 ? 's' : ''} within ${radiusKm} km of this route section.`, 'ok');

    const badge = document.getElementById('sqBadge');
    if (badge) { badge.textContent = cnt; badge.style.display = 'block'; }
    const countLabel = document.getElementById('sqCountLabel');
    if (countLabel) countLabel.textContent = `${cnt} found`;
}

// Bounded Overpass query helper: single request with 1 fallback attempt
async function queryOverpassSingleBounded(lat, lon, radiusM, filterCat) {
    const queryQl = buildSinglePointOverpassQuery(lat, lon, radiusM, filterCat);

    for (const endpoint of OVERPASS_ENDPOINTS) {
        try {
            let res = null;
            if (endpoint.startsWith('/')) {
                // Internal resilient proxy
                res = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ data: queryQl }),
                    signal: AbortSignal.timeout(16000)
                });
            } else {
                // Direct public fallback
                res = await fetch(endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Accept': 'application/json'
                    },
                    body: 'data=' + encodeURIComponent(queryQl),
                    signal: AbortSignal.timeout(14000)
                });
            }

            const data = await res.json().catch(() => null);

            if (!res.ok || (data && data.ok === false)) {
                const errStatus = res.status || data?.statusCode || 502;
                const errMsg    = data?.error || `HTTP ${res.status}`;
                console.warn(`[TripMate Overpass] Endpoint ${endpoint} returned:`, errStatus, errMsg);
                // If 429 or server timeout, try the single fallback after a brief pause
                continue;
            }

            const elements = (data && data.elements) ? data.elements : [];
            return { ok: true, elements, endpoint };

        } catch (err) {
            console.warn(`[TripMate Overpass] Endpoint ${endpoint} fetch exception:`, err.message || err);
            // Continue to fallback
        }
    }

    return {
        ok: false,
        status: 504,
        error: 'Overpass mirrors timed out or returned errors'
    };
}

function buildSinglePointOverpassQuery(lat, lon, radiusM, filterCat) {
    // Explicit syntax: (around:radius_in_meters,latitude,longitude)
    const R      = radiusM;
    const latStr = lat.toFixed(5);
    const lonStr = lon.toFixed(5);
    const clauses = [];

    if (!filterCat || filterCat === 'attraction') {
        clauses.push(`nwr["tourism"~"attraction|artwork|museum"]["name"](around:${R},${latStr},${lonStr});`);
    }
    if (!filterCat || filterCat === 'viewpoint') {
        clauses.push(`nwr["tourism"="viewpoint"]["name"](around:${R},${latStr},${lonStr});`);
    }
    if (!filterCat || filterCat === 'historic') {
        clauses.push(`nwr["historic"]["name"](around:${R},${latStr},${lonStr});`);
    }
    if (!filterCat || filterCat === 'nature') {
        clauses.push(`nwr["natural"~"waterfall|peak|spring|cave_entrance"]["name"](around:${R},${latStr},${lonStr});`);
        clauses.push(`nwr["leisure"~"nature_reserve|park"]["name"](around:${R},${latStr},${lonStr});`);
    }
    if (!filterCat || filterCat === 'temple') {
        clauses.push(`nwr["amenity"="place_of_worship"]["name"](around:${R},${latStr},${lonStr});`);
    }
    if (!filterCat || filterCat === 'cafe') {
        clauses.push(`node["amenity"="cafe"]["name"](around:${R},${latStr},${lonStr});`);
    }
    if (!filterCat || filterCat === 'market') {
        clauses.push(`nwr["shop"="market"]["name"](around:${R},${latStr},${lonStr});`);
    }
    if (!filterCat || filterCat === 'museum') {
        clauses.push(`nwr["tourism"="museum"]["name"](around:${R},${latStr},${lonStr});`);
    }

    // Strict limit to ensure fast response under 3s
    return `[out:json][timeout:15];\n(\n  ${clauses.join('\n  ')}\n);\nout center tags 20;`;
}

function resetDiscoverBtn(btn) {
    if (!btn) return;
    btn.disabled = false;
    btn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        Discover Along Section
    `;
}

function sqCategoryFor(tags) {
    if (!tags) return 'other';
    const t = tags.tourism, a = tags.amenity, h = tags.historic,
          n = tags.natural,  l = tags.leisure, shop = tags.shop;
    if (t === 'viewpoint')                          return 'viewpoint';
    if (t === 'attraction' || t === 'artwork')       return 'attraction';
    if (h)                                           return 'historic';
    if (n === 'waterfall')                           return 'waterfall';
    if (n || l === 'nature_reserve')                 return 'nature';
    if (a === 'cafe' || a === 'restaurant')          return 'cafe';
    if (shop === 'market' || a === 'marketplace')    return 'market';
    if (a === 'place_of_worship' || tags.religion)   return 'temple';
    if (a === 'museum' || t === 'museum')            return 'museum';
    if (l === 'park')                                return 'nature';
    return 'other';
}

function defaultDuration(cat) {
    return {
        viewpoint: 30, attraction: 60, historic: 60, nature: 45,
        waterfall: 45, temple: 45, cafe: 30, market: 45, museum: 90
    }[cat] || 45;
}

// ─── Render Side Quest Cards (matching UI photo3) ────
function renderSqResults(allResults) {
    const list     = document.getElementById('sqResultsList');
    const notice   = document.getElementById('sqEmptyNotice');
    const filterEl = document.getElementById('sqInterestFilter');
    const catFilter = filterEl ? filterEl.value : '';
    if (!list) return;

    list.innerHTML = '';
    const filtered = catFilter ? allResults.filter(r => r.category === catFilter) : allResults;

    if (!filtered.length) {
        list.style.display = 'none';
        if (notice) {
            notice.textContent = `No "${catFilter}" spots found in this corridor.`;
            notice.style.display = 'block';
        }
        return;
    }

    if (notice) notice.style.display = 'none';
    list.style.display = 'flex';

    filtered.forEach(item => {
        const catInfo  = SQ_CATEGORIES[item.category] || SQ_CATEGORIES.other;
        const isAdded  = sqAddedIds.has(item.id);
        const distStr  = item.distFromRouteKm != null ? `${item.distFromRouteKm.toFixed(1)} km from route` : '—';
        const dayLabel = `Day ${item.dayIdx + 1}`;
        const osmLink  = `https://www.openstreetmap.org/${item.osmType || 'node'}/${item.osmId}`;
        const detour   = sqDetourData[item.id];

        const li = document.createElement('li');
        li.className = `sq-card${isAdded ? ' added' : ''}`;
        li.style.setProperty('--sq-color', catInfo.color);
        li.style.setProperty('--sq-color-light', catInfo.light);
        li.dataset.sqId = item.id;

        li.innerHTML = `
            <div class="sq-card-top">
                <div class="sq-thumb-icon" aria-hidden="true">${catInfo.icon}</div>
                <div class="sq-header-text">
                    <div class="sq-name">${escapeHtml(item.name)}</div>
                    <div class="sq-category-label">${escapeHtml(catInfo.label)}</div>
                    ${item.region ? `<div class="sq-region-text">${escapeHtml(item.region)}</div>` : ''}
                </div>
                <div class="sq-select-circle" title="${isAdded ? 'Added to trip' : 'Not added'}">
                    ${isAdded ? '✓' : ''}
                </div>
            </div>

            <!-- Distance from route corridor -->
            <div class="sq-metrics-row">
                <div class="sq-metric-item">
                    <span aria-hidden="true">📍</span>
                    <span>${escapeHtml(distStr)}</span>
                </div>
                <div class="sq-metric-item">
                    <span aria-hidden="true">🚗</span>
                    <span>~${Math.round((item.distFromRouteKm || 5) * 2.2)} min off-road</span>
                </div>
                <span class="sq-day-tag">${escapeHtml(dayLabel)}</span>
            </div>

            <!-- Detour estimate badge -->
            <div class="sq-detour-loading" id="sq-load-${escapeHtml(item.id)}">⏳ Calculating route detour with OSRM…</div>
            <div class="sq-detour-badge ${detour ? 'visible' : ''}" id="sq-badge-${escapeHtml(item.id)}">
                ${detour ? `<span>🚗 Added Detour: +${detour.extraDistKm.toFixed(1)} km · +${detour.extraDurMin} min</span>` : ''}
            </div>

            <!-- Visit duration editable estimate -->
            <div class="sq-duration-row">
                <div class="sq-duration-wrap">
                    <span>Est. Visit:</span>
                    <input class="sq-duration-input" type="number" min="15" max="360" step="15"
                           value="${item.durationMins}" aria-label="Estimated visit duration">
                    <span>min</span>
                </div>
                <a class="sq-osm-link" href="${osmLink}" target="_blank" rel="noopener noreferrer">OSM Verified ↗</a>
            </div>

            <!-- Actions: Add or Remove if detour is too large -->
            <div class="sq-actions-row">
                ${isAdded ? `
                    <button class="sq-action-btn added-state" disabled>✓ Added</button>
                    <button class="sq-action-btn remove-detour" title="Detour too large? Remove stop">✕ Remove Detour</button>
                ` : `
                    <button class="sq-action-btn add">+ Add to Trip</button>
                `}
                <button class="sq-action-btn map-btn" title="View on map" aria-label="View ${escapeHtml(item.name)} on map">🗺️</button>
            </div>
        `;

        // Clicking card body focuses map on that place
        li.addEventListener('click', e => {
            if (e.target.closest('button') || e.target.closest('input') || e.target.closest('a')) return;
            map.setView([item.lat, item.lon], 14);
            const mk = sqMarkers.find(m => m._sqId === item.id);
            if (mk) mk.openPopup();
            showFeaturedCard(item);
        });

        // Handle Visit Duration edit
        li.querySelector('.sq-duration-input').addEventListener('change', e => {
            item.durationMins = Math.max(15, parseInt(e.target.value) || 30);
            const found = tripStops.find(s => s.sqId === item.id);
            if (found) {
                found.durationMins = item.durationMins;
                renderStopsList();
            }
        });

        // Handle Add to Trip
        const addBtn = li.querySelector('.sq-action-btn.add');
        if (addBtn) {
            addBtn.addEventListener('click', async e => {
                e.stopPropagation();
                await handleAddSideQuest(item, li);
            });
        }

        // Handle Remove Detour (if detour is too large)
        const removeBtn = li.querySelector('.sq-action-btn.remove-detour');
        if (removeBtn) {
            removeBtn.addEventListener('click', e => {
                e.stopPropagation();
                handleRemoveSideQuest(item);
            });
        }

        // View on Map
        li.querySelector('.sq-action-btn.map-btn').addEventListener('click', e => {
            e.stopPropagation();
            map.setView([item.lat, item.lon], 14);
            const mk = sqMarkers.find(m => m._sqId === item.id);
            if (mk) mk.openPopup();
            showFeaturedCard(item);
        });

        list.appendChild(li);
    });
}

async function handleAddSideQuest(item, cardEl) {
    if (sqAddedIds.has(item.id)) return;
    sqAddedIds.add(item.id);

    const catInfo  = SQ_CATEGORIES[item.category] || SQ_CATEGORIES.other;
    const prevDist = currentRouteDistKm;
    const prevDur  = currentRouteDurMin;

    addStop({
        id:           'sq-stop-' + Date.now(),
        sqId:         item.id,
        name:         item.name,
        lat:          item.lat,
        lon:          item.lon,
        type:         'optional',
        durationMins: item.durationMins,
        category:     catInfo.label + ' (Side Quest)'
    });

    const loadEl = document.getElementById(`sq-load-${item.id}`);
    if (loadEl) loadEl.classList.add('visible');

    // Recalculate route with new stop
    await calculateMultiStopRouteAndSchedule();

    // Compute detour difference
    const extraDistKm = Math.max(0, currentRouteDistKm - prevDist);
    const extraDurMin = Math.max(0, currentRouteDurMin - prevDur);
    sqDetourData[item.id] = { extraDistKm, extraDurMin };

    if (loadEl) loadEl.classList.remove('visible');

    renderSqResults(sideQuestResults);
    refreshSqCardsState();
}

function handleRemoveSideQuest(item) {
    sqAddedIds.delete(item.id);
    delete sqDetourData[item.id];

    const idx = tripStops.findIndex(s => s.sqId === item.id);
    if (idx !== -1) {
        tripStops.splice(idx, 1);
        renderStopsList();
    }

    renderSqResults(sideQuestResults);
    refreshSqCardsState();

    if (tripConfig.originCoords && tripConfig.destCoords) {
        calculateMultiStopRouteAndSchedule();
    }
}

function refreshSqCardsState() {
    document.querySelectorAll('.sq-card').forEach(card => {
        const id      = card.dataset.sqId;
        const isAdded = sqAddedIds.has(id);
        card.classList.toggle('added', isAdded);
    });
}

function placeSqMarkersOnMap(results) {
    clearSqMarkers();
    results.forEach(item => {
        const catInfo = SQ_CATEGORIES[item.category] || SQ_CATEGORIES.other;
        const distStr = item.distFromRouteKm != null ? `${item.distFromRouteKm.toFixed(1)} km from route` : '';

        const m = L.circleMarker([item.lat, item.lon], {
            radius: 7,
            fillColor: catInfo.color,
            color: '#ffffff',
            weight: 2,
            opacity: 1,
            fillOpacity: 0.9
        }).addTo(map);

        m._sqId = item.id;
        m.bindPopup(`
            <b>${escapeHtml(item.name)}</b><br>
            <span style="color:${catInfo.color};font-weight:700">${catInfo.icon} ${catInfo.label}</span><br>
            <small>📍 ${distStr}</small><br>
            <small style="color:#718a7c">OpenStreetMap Verified</small>
        `);

        m.on('click', () => {
            showFeaturedCard(item);
        });

        sqMarkers.push(m);
    });
}

function clearSqMarkers() {
    sqMarkers.forEach(m => map.removeLayer(m));
    sqMarkers = [];
}

function showSqStatus(msg, type = 'info') {
    const el = document.getElementById('sqStatus');
    if (!el) return;
    el.style.display = 'block';
    el.textContent   = msg;
    el.style.background = type === 'ok' ? '#eaf5ee' : (type === 'warn' ? '#fef9c3' : '#f0faf4');
    el.style.color      = type === 'ok' ? '#1b4332' : (type === 'warn' ? '#854d0e' : '#2d6a4f');
}

// =====================================================
// 8. FEATURED CARD ON MAP (UI photo3 Style)
// =====================================================
function setupFeaturedCardUI() {
    const closeBtn = document.getElementById('closeFeaturedCardBtn');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            const card = document.getElementById('mapFeaturedCard');
            if (card) card.style.display = 'none';
        });
    }
}

function showFeaturedCard(item) {
    const card = document.getElementById('mapFeaturedCard');
    if (!card) return;

    const catInfo  = SQ_CATEGORIES[item.category] || SQ_CATEGORIES.other;
    const catEl    = document.getElementById('featuredCategory');
    const titleEl  = document.getElementById('featuredTitle');
    const descEl   = document.getElementById('featuredDesc');
    const distEl   = document.getElementById('featuredDist');
    const driveEl  = document.getElementById('featuredDrive');
    const addBtn   = document.getElementById('featuredAddBtn');

    if (catEl)   catEl.textContent   = `${catInfo.icon} ${catInfo.label}`;
    if (titleEl) titleEl.textContent = item.name;
    if (descEl)  descEl.textContent  = item.region || `Worthwhile spot situated ${item.distFromRouteKm?.toFixed(1) || ''} km off your planned route.`;
    if (distEl)  distEl.textContent  = `📍 ${item.distFromRouteKm?.toFixed(1) || '0'} km from route`;
    if (driveEl) driveEl.textContent = `🚗 ~${Math.round((item.distFromRouteKm || 5) * 2.2)} min off-road`;

    const isAdded = sqAddedIds.has(item.id);
    if (addBtn) {
        addBtn.textContent = isAdded ? '✓ Added to Trip' : '+ Add to Trip';
        addBtn.disabled    = isAdded;
        addBtn.onclick = async () => {
            await handleAddSideQuest(item);
            addBtn.textContent = '✓ Added to Trip';
            addBtn.disabled = true;
        };
    }

    card.style.display = 'block';
}

// =====================================================
// 9. DAY-BY-DAY SCHEDULER & DELAY SIMULATOR
// =====================================================
function generateDayByDaySchedule(legs, waypoints, delayMins = 0) {
    currentDelayMinutes = delayMins;
    const timelineEl = document.getElementById('itineraryTimeline');
    if (!timelineEl) return;
    timelineEl.innerHTML = '';

    const numDays  = Math.max(1, tripConfig.days);
    const limitMin = tripConfig.dailyLimitHours * 60;
    const [sh, sm] = tripConfig.startTime.split(':').map(Number);
    let clockMin   = (sh || 9) * 60 + (sm || 0) + delayMins;

    const perDay = Math.ceil(tripStops.length / numDays) || 1;
    let stopIdx = 0, legIdx = 0, anyOverflow = false;
    currentSchedule = [];

    for (let day = 1; day <= numDays; day++) {
        const events = [];
        let dayMins  = 0;

        events.push({
            time: formatClock(clockMin),
            type: 'start',
            title: `Depart from ${day === 1 ? (tripConfig.origin || 'Origin') : `Day ${day} stop`}`,
            detail: ''
        });

        const countThisDay = day === numDays ? tripStops.length - stopIdx : Math.min(perDay, tripStops.length - stopIdx);

        for (let s = 0; s < countThisDay; s++) {
            const stop      = tripStops[stopIdx];
            const leg       = legs?.[legIdx] ?? { duration: 1800, distance: 15000 };
            const driveMins = Math.round(leg.duration / 60);

            clockMin += driveMins;
            dayMins  += driveMins;
            events.push({
                time: formatClock(clockMin),
                type: 'drive',
                title: `Drive to ${stop.name}`,
                detail: `~${driveMins} min · ${(leg.distance / 1000).toFixed(1)} km (est.)`
            });

            // Midday lunch buffer (1:00 PM - 2:00 PM)
            if (clockMin % (24 * 60) >= 13 * 60 && clockMin % (24 * 60) <= 14 * 60) {
                clockMin += 45;
                dayMins  += 45;
                events.push({
                    time: formatClock(clockMin),
                    type: 'break',
                    title: 'Midday Lunch & Rest',
                    detail: '45 min buffer'
                });
            }

            const visitEnd = clockMin + stop.durationMins;
            events.push({
                time: `${formatClock(clockMin)} – ${formatClock(visitEnd)}`,
                type: 'visit',
                isMust: stop.type === 'must_visit',
                title: `${stop.name} (${stop.durationMins} min)`,
                detail: stop.type === 'must_visit' ? '★ Must-Visit' : '○ Optional'
            });

            clockMin += stop.durationMins;
            dayMins  += stop.durationMins;
            stopIdx++;
            legIdx++;
        }

        if (day === numDays) {
            const fl = legs?.[legIdx] ?? { duration: 1800, distance: 15000 };
            const fm = Math.round(fl.duration / 60);
            clockMin += fm;
            dayMins  += fm;
            events.push({
                time: formatClock(clockMin),
                type: 'finish',
                title: `Arrive at ${tripConfig.destination || 'Destination'}`,
                detail: `~${fm} min driving (est.)`
            });
        }

        const overflow = dayMins > limitMin;
        if (overflow) anyOverflow = true;
        currentSchedule.push({ day, events, totalMinutes: dayMins, isOverflow: overflow });

        const block = document.createElement('div');
        block.className = 'day-block';
        const hrs = (dayMins / 60).toFixed(1);
        block.innerHTML = `
            <div class="day-header">
                <span>Day ${day}</span>
                <span class="day-status ${overflow ? 'overflow' : 'ok'}">
                    ${overflow ? `⚠ ${hrs}h (exceeds ${tripConfig.dailyLimitHours}h)` : `✓ ${hrs}h`}
                </span>
            </div>
        `;

        events.forEach(ev => {
            const evDiv = document.createElement('div');
            evDiv.className = 'timeline-event';
            const badge = ev.type === 'drive' ? '<span class="event-badge badge-drive">Drive</span>' :
                          (ev.type === 'visit' ? `<span class="event-badge badge-visit">${ev.isMust ? 'Must-Visit' : 'Optional'}</span>` :
                          (ev.type === 'break' ? '<span class="event-badge badge-break">Break</span>' : ''));

            evDiv.innerHTML = `
                <div class="event-time">${ev.time}</div>
                <div class="event-details">
                    <div>${badge}<strong>${escapeHtml(ev.title)}</strong></div>
                    <div style="color:#556b5e;font-size:0.67rem">${escapeHtml(ev.detail)}</div>
                </div>
            `;
            block.appendChild(evDiv);
        });

        timelineEl.appendChild(block);
    }

    evaluateDelayRemedies(anyOverflow, delayMins);
}

function setupDelayAndAiUI() {
    const applyBtn   = document.getElementById('applyDelayBtn');
    const delayInput = document.getElementById('delayMinutesInput');
    const aiBtn      = document.getElementById('triggerAiAnalysisBtn');

    if (applyBtn && delayInput) {
        applyBtn.addEventListener('click', () => {
            if (!currentRouteData) {
                alert('Please calculate a route first.');
                return;
            }
            const dm = Math.max(0, parseInt(delayInput.value) || 0);
            const waypoints = [
                { name: tripConfig.origin,      lat: tripConfig.originCoords.lat, lon: tripConfig.originCoords.lon },
                ...tripStops,
                { name: tripConfig.destination, lat: tripConfig.destCoords.lat,   lon: tripConfig.destCoords.lon }
            ];
            generateDayByDaySchedule(currentRouteData.legs, waypoints, dm);
            requestGeminiExplanation();
        });
    }

    if (aiBtn) aiBtn.addEventListener('click', requestGeminiExplanation);
}

function evaluateDelayRemedies(overflow, delayMins) {
    const notice = document.getElementById('delaySuggestionNotice');
    if (!notice) return;
    if (!overflow && delayMins === 0) {
        notice.style.display = 'none';
        return;
    }

    notice.style.display = 'block';

    if (!overflow) {
        notice.innerHTML = `<strong>On Track:</strong> ${delayMins}-min delay absorbed within your available buffer.`;
        return;
    }

    const opt = tripStops.find(s => s.type === 'optional');
    if (opt) {
        notice.innerHTML = `
            <strong>⚠ Schedule Overflow (${delayMins} min delay):</strong> Schedule exceeds your daily limit.
            <div style="margin-top:5px;font-weight:700;color:#1b4332;">
                Consider skipping "${escapeHtml(opt.name)}" to recover ${opt.durationMins} minutes.
            </div>
            <div style="margin-top:6px;">
                <button class="btn-remedy" onclick="remedySkipStop('${opt.id}')">Skip this stop</button>
                <button class="btn-remedy" onclick="remedyShortenStop('${opt.id}', 30)">Shorten to 30 min</button>
            </div>
        `;
    } else {
        notice.innerHTML = '<strong>⚠ Schedule Overflow:</strong> All stops are Must-Visit. Extend daily hours limit or shorten visit durations.';
    }
}

window.remedySkipStop = id => {
    const idx = tripStops.findIndex(s => s.id === id);
    if (idx !== -1) {
        const removed = tripStops.splice(idx, 1)[0];
        if (removed && removed.sqId) {
            sqAddedIds.delete(removed.sqId);
            delete sqDetourData[removed.sqId];
        }
        renderStopsList();
        refreshSqCardsState();
        calculateMultiStopRouteAndSchedule();
    }
};

window.remedyShortenStop = (id, mins) => {
    const s = tripStops.find(s => s.id === id);
    if (s) {
        s.durationMins = mins;
        renderStopsList();
        calculateMultiStopRouteAndSchedule();
    }
};

// =====================================================
// 10. PLACES SEARCH (Nominatim Manual POI Lookup)
// =====================================================
function setupPlacesSearchUI() {
    const searchInput    = document.getElementById('searchInput');
    const searchBtn      = document.getElementById('searchBtn');
    const clearSearchBtn = document.getElementById('clearSearchBtn');
    const chips          = document.getElementById('categoryChips');
    if (!searchInput || !searchBtn) return;

    searchBtn.addEventListener('click', () => executePlacesSearch());
    searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') executePlacesSearch(); });

    searchInput.addEventListener('input', () => {
        clearSearchBtn.style.display = searchInput.value.trim() ? 'block' : 'none';
    });

    clearSearchBtn.addEventListener('click', () => {
        searchInput.value = '';
        clearSearchBtn.style.display = 'none';
        searchInput.focus();
        showPlacesMsg('Search a place to add it as a route stop.');
    });

    if (chips) {
        chips.querySelectorAll('.chip').forEach(chip => {
            chip.addEventListener('click', () => {
                chips.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                const cat = chip.getAttribute('data-type');
                if (cat) {
                    searchInput.value = cat;
                    executePlacesSearch();
                }
            });
        });
    }
}

async function executePlacesSearch() {
    const searchInput = document.getElementById('searchInput');
    const query = searchInput ? searchInput.value.trim() : '';
    if (!query) {
        showPlacesMsg('Please enter a location or place name.');
        return;
    }

    showPlacesMsg('Searching OpenStreetMap…');
    const wait = NOMINATIM_MIN_MS - (Date.now() - lastNominatimTs);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastNominatimTs = Date.now();

    try {
        const res = await fetch(
            `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&addressdetails=1&limit=8`,
            { headers: { 'Accept': 'application/json' } }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        if (!data || !data.length) {
            clearSearchMarkers();
            showPlacesMsg(`No places found for "${query}". Try another query.`);
            return;
        }

        renderPlacesResults(data);
    } catch (err) {
        console.error('Places search error:', err);
        clearSearchMarkers();
        showPlacesMsg('Could not retrieve search results. Please check your connection.', true);
    }
}

function renderPlacesResults(places) {
    clearSearchMarkers();
    const msg  = document.getElementById('resultsMessage');
    const list = document.getElementById('resultsList');
    if (!list || !msg) return;

    msg.style.display = 'none';
    list.innerHTML = '';
    list.style.display = 'flex';

    const bounds = [];
    places.forEach(place => {
        const lat = parseFloat(place.lat);
        const lon = parseFloat(place.lon);
        if (isNaN(lat) || isNaN(lon)) return;
        bounds.push([lat, lon]);

        const parts     = place.display_name.split(',');
        const shortName = parts[0].trim();
        const region    = parts.slice(1, 4).join(',').trim();
        const category  = (place.type || place.class || 'place').replace(/_/g, ' ');

        const marker = L.marker([lat, lon]).addTo(map);
        marker.bindPopup(`<b>${escapeHtml(shortName)}</b><br><small>${escapeHtml(place.display_name)}</small>`);
        searchMarkers.push(marker);

        const li = document.createElement('li');
        li.className = 'result-item';
        li.innerHTML = `
            <div class="result-name">${escapeHtml(shortName)}</div>
            <div class="result-address">${escapeHtml(region || place.display_name)}</div>
            <div class="result-footer">
                <span class="result-badge">${escapeHtml(category)}</span>
                <button class="btn-add-stop">+ Add as Stop</button>
            </div>
        `;

        li.addEventListener('click', e => {
            if (e.target.classList.contains('btn-add-stop')) return;
            map.setView([lat, lon], 14);
            marker.openPopup();
        });

        li.querySelector('.btn-add-stop').addEventListener('click', () => {
            addStop({
                id:           'srch-' + Date.now(),
                name:         shortName,
                lat:          lat,
                lon:          lon,
                type:         'must_visit',
                durationMins: 60,
                category:     category
            });
            switchToTab('tab-plan');
        });

        list.appendChild(li);
    });

    if (bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
}

function showPlacesMsg(text, isError = false) {
    const el   = document.getElementById('resultsMessage');
    const list = document.getElementById('resultsList');
    if (list) list.style.display = 'none';
    if (el) {
        el.style.display = 'block';
        el.className     = `results-message${isError ? ' error' : ''}`;
        el.innerHTML     = `<p>${escapeHtml(text)}</p>`;
    }
}

function clearSearchMarkers() {
    searchMarkers.forEach(m => map.removeLayer(m));
    searchMarkers = [];
}

// =====================================================
// 11. GEMINI AI TRADE-OFF ANALYSIS (Secure Backend Proxy)
// =====================================================
async function checkGeminiConfig() {
    const badge = document.getElementById('aiBadge');
    try {
        const res  = await fetch('/api/config');
        const data = await res.json();
        if (badge) {
            badge.textContent      = data.hasGeminiKey ? '✨ Gemini AI' : 'Local Mode';
            badge.style.background = data.hasGeminiKey ? '#dcfce7' : '#fef9c3';
            badge.style.color      = data.hasGeminiKey ? '#15803d' : '#854d0e';
        }
    } catch (_) {
        if (badge) badge.textContent = 'Local Mode';
    }
}

async function requestGeminiExplanation() {
    const aiEl     = document.getElementById('aiExplanation');
    const rankSec  = document.getElementById('aiRankingSection');
    const rankList = document.getElementById('aiRankingsList');
    const badge    = document.getElementById('aiBadge');
    if (!aiEl) return;

    aiEl.textContent = 'Analyzing schedule with Gemini AI…';

    const payload = {
        trip: {
            origin:          tripConfig.origin,
            destination:     tripConfig.destination,
            days:            tripConfig.days,
            startTime:       tripConfig.startTime,
            dailyLimitHours: tripConfig.dailyLimitHours,
            interests:       tripConfig.interests
        },
        stops:        tripStops.map(s => ({ name: s.name, type: s.type, durationMins: s.durationMins, category: s.category || '' })),
        itinerary:    currentSchedule,
        delayMinutes: currentDelayMinutes,
        overflow:     currentSchedule.some(d => d.isOverflow)
    };

    try {
        const res = await fetch('/api/gemini/explain', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error(`Server HTTP ${res.status}`);
        const data = await res.json();

        aiEl.textContent = data.explanation || 'Schedule analyzed successfully.';

        if (badge) {
            const isLive = data.source?.includes('gemini');
            badge.textContent      = isLive ? '✨ Gemini Live' : 'Local Analysis';
            badge.style.background = isLive ? '#dcfce7' : '#fef9c3';
            badge.style.color      = isLive ? '#15803d' : '#854d0e';
        }

        if (data.rankings?.length && rankList && rankSec) {
            rankSec.style.display = 'block';
            rankList.innerHTML = '';
            data.rankings.forEach(item => {
                const li = document.createElement('li');
                li.className = 'ranking-item';
                li.innerHTML = `
                    <span><strong>${escapeHtml(item.name)}</strong>: <small style="color:#556b5e">${escapeHtml(item.reason || '')}</small></span>
                    <span class="rank-priority ${item.priority || 'Medium'}">${escapeHtml(item.priority || 'Medium')}</span>
                `;
                rankList.appendChild(li);
            });
        }
    } catch (err) {
        console.error('Gemini explanation error:', err);
        aiEl.textContent = 'Schedule created from verified OSRM estimates. Protect Must-Visit stops if unexpected delays occur.';
    }
}

// =====================================================
// 12. UTILITIES & GEOSPATIAL MATH
// =====================================================
function updateHeaderStats() {
    const titleEl   = document.getElementById('tripHeaderTitle');
    const daysEl    = document.getElementById('metaDaysCount');
    const stopsEl   = document.getElementById('metaStopsCount');
    const sumPill   = document.getElementById('routeSummary');
    const sumText   = document.getElementById('routeSummaryText');

    if (titleEl) {
        if (tripConfig.origin && tripConfig.destination) {
            titleEl.textContent = `${tripConfig.origin} to ${tripConfig.destination}`;
        } else {
            titleEl.textContent = 'My Next Journey';
        }
    }

    if (daysEl)  daysEl.textContent  = tripConfig.days;
    if (stopsEl) stopsEl.textContent = tripStops.length;

    if (sumPill && sumText) {
        if (currentRouteDistKm > 0) {
            sumText.textContent = `${currentRouteDistKm.toFixed(0)} km · ${formatDuration(currentRouteDurMin)}`;
            sumPill.style.display = 'inline-flex';
        } else {
            sumPill.style.display = 'none';
        }
    }

    const mapTopDest = document.getElementById('mapTopDestination');
    if (mapTopDest) {
        if (tripConfig.destination) {
            mapTopDest.textContent = tripConfig.destination;
        } else if (tripConfig.origin) {
            mapTopDest.textContent = tripConfig.origin;
        } else {
            mapTopDest.textContent = 'Explore Corridor';
        }
    }
}

// Great-circle Haversine formula (km)
function haversineKm(lat1, lon1, lat2, lon2) {
    const R    = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a    = Math.sin(dLat / 2) ** 2
               + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
               * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Straight-line distance from point to nearest route polyline waypoint (km)
function distToRouteKm(lat, lon) {
    if (!currentRouteGeom || !currentRouteGeom.length) return null;
    let minDist = Infinity;
    currentRouteGeom.forEach(([rlon, rlat]) => {
        const d = haversineKm(lat, lon, rlat, rlon);
        if (d < minDist) minDist = d;
    });
    return minDist;
}

function formatClock(totalMin) {
    const h24 = Math.floor(totalMin / 60) % 24;
    const m   = totalMin % 60;
    const h12 = h24 % 12 || 12;
    return `${h12}:${String(m).padStart(2, '0')} ${h24 >= 12 ? 'PM' : 'AM'}`;
}

function formatDuration(mins) {
    if (mins < 60) return `~${mins} min`;
    return `~${Math.floor(mins / 60)}h ${mins % 60 > 0 ? (mins % 60) + 'm' : ''}`;
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
