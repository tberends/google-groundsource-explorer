(function () {
    "use strict";

    // ── State ──────────────────────────────────────────────────────────
    const DETAIL_ZOOM = 8;
    // Compact type codes from preprocessing
    const TYPE_NAMES = { 1: "Point", 2: "MultiPoint", 3: "LineString",
                         4: "Polygon", 5: "MultiPolygon", 6: "GeometryCollection" };

    const state = {
        timeline: [],           // [{month, count}]
        heatmapCache: {},       // year -> {month: [[lat,lng,count],...]}
        allMonths: [],          // ["2000-01", "2000-02", ...]
        rangeStart: 0,          // index into allMonths
        rangeEnd: 0,
        animating: false,
        animationIdx: 0,
        animationTimer: null,
        totalEvents: 0,
        singleMonthIdx: -1,     // -1 = range mode, >=0 = showing one month
        tileIndex: {},          // {"lat_lon": eventCount}
        tileCache: {},          // {"lat_lon": [events...]}
        loadingTiles: {},       // {"lat_lon": Promise}
        detailMode: false,
    };

    // ── DOM refs ───────────────────────────────────────────────────────
    const $ = (s) => document.querySelector(s);
    const mapEl = $("#map");
    const btnPlay = $("#btn-play");
    const btnPause = $("#btn-pause");
    const btnReset = $("#btn-reset");
    const speedSlider = $("#speed-slider");
    const rangeStartEl = $("#range-start");
    const rangeEndEl = $("#range-end");
    const rangeEventCountEl = $("#range-event-count");
    const statEvents = $("#stat-events");
    const statRange = $("#stat-range");
    const currentPeriodEl = $("#current-period");
    const loadingOverlay = $("#loading-overlay");
    const infoOverlay = $("#info-overlay");
    const infoOverlayClose = $(".info-overlay-close");
    const infoOverlayBackdrop = $(".info-overlay-backdrop");
    const linkInfo = $("#link-info");

    // ── Map setup ──────────────────────────────────────────────────────
    const map = L.map(mapEl, {
        center: [25, 0],
        zoom: 3,
        minZoom: 2,
        maxZoom: 12,
        zoomControl: true,
        worldCopyJump: false,
        maxBounds: [[-85, -200], [85, 200]],
        maxBoundsViscosity: 1.0,
    });

    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a> | Data: <a href="https://doi.org/10.5281/zenodo.18647053">Groundsource</a>',
        subdomains: "abcd",
        maxZoom: 19,
        noWrap: true,
    }).addTo(map);

    let heatLayer = null;

    // ── Chart setup ────────────────────────────────────────────────────
    let chart = null;
    const chartCanvas = $("#timeline-chart");

    function getMaxYearTicks() {
        const w = chartCanvas ? chartCanvas.getBoundingClientRect().width : window.innerWidth;
        return Math.max(6, Math.min(35, Math.floor(w / 45)));
    }

    function initChart(labels, data) {
        const ctx = chartCanvas.getContext("2d");

        chart = new Chart(ctx, {
            type: "bar",
            data: {
                labels: labels,
                datasets: [{
                    data: data,
                    backgroundColor: "rgba(77, 166, 255, 0.5)",
                    borderColor: "rgba(77, 166, 255, 0.8)",
                    borderWidth: 0.5,
                    barPercentage: 1.0,
                    categoryPercentage: 1.0,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            title: (items) => items[0].label,
                            label: (item) => `${item.raw.toLocaleString()} events`,
                        },
                        backgroundColor: "#1a1d27",
                        titleColor: "#e4e6f0",
                        bodyColor: "#9398a8",
                        borderColor: "#2e3348",
                        borderWidth: 1,
                    },
                },
                scales: {
                    x: {
                        display: true,
                        ticks: {
                            color: "#9398a8",
                            font: { size: 14 },
                            maxRotation: 0,
                            autoSkip: true,
                            maxTicksLimit: getMaxYearTicks(),
                            callback: function (val, idx) {
                                const label = this.getLabelForValue(val);
                                return label.endsWith("-01") ? label.substring(0, 4) : "";
                            },
                        },
                        grid: { display: false },
                    },
                    y: {
                        display: true,
                        ticks: {
                            color: "#9398a8",
                            font: { size: 10 },
                            maxTicksLimit: 4,
                            callback: (v) => v >= 1000 ? (v / 1000).toFixed(0) + "k" : v,
                        },
                        grid: {
                            color: "rgba(46, 51, 72, 0.4)",
                        },
                    },
                },
                interaction: {
                    mode: "index",
                    intersect: false,
                },
            },
        });
    }

    // ── Single-month selection via click on timeline ──────────────────────
    function handleTimelineClick(e) {
        if (!chart) return;
        const rect = chartCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const idx = pixelToIndex(x);
        if (idx < 0 || idx >= state.allMonths.length) return;

        if (state.singleMonthIdx === idx) {
            exitSingleMonth();
        } else {
            showSingleMonth(idx);
        }
    }

    function showSingleMonth(idx) {
        if (state.animating) stopAnimation();
        state.singleMonthIdx = idx;

        lastHeatPoints = collectHeatPoints(idx, idx);
        if (state.detailMode) {
            updateDetailLayer();
        } else {
            renderHeatLayer(lastHeatPoints);
        }

        highlightChartBar(idx);
        currentPeriodEl.style.display = "block";
        currentPeriodEl.textContent = formatMonth(state.allMonths[idx]);

        const count = state.timeline[idx].count;
        rangeStartEl.textContent = formatMonth(state.allMonths[idx]);
        rangeEndEl.textContent = formatMonth(state.allMonths[idx]);
        rangeEventCountEl.textContent = count.toLocaleString();
    }

    function exitSingleMonth() {
        state.singleMonthIdx = -1;
        currentPeriodEl.style.display = "none";
        resetChartHighlight();
        updateBrushVisuals();
        updateRangeDisplay();
        updateHeatmap();
    }

    // ── Brush / range selection ─────────────────────────────────────────
    const brushOverlay = $("#brush-overlay");
    const brushLeft = $("#brush-left");
    const brushRight = $("#brush-right");
    const brushSelection = $("#brush-selection");

    function getChartArea() {
        if (!chart) return { left: 0, right: 0, width: 0 };
        const ca = chart.chartArea;
        return { left: ca.left, right: ca.right, width: ca.right - ca.left };
    }

    function indexToPixel(idx) {
        const { left, width } = getChartArea();
        const n = state.allMonths.length;
        return left + (idx / (n - 1)) * width;
    }

    function pixelToIndex(px) {
        const { left, width } = getChartArea();
        const n = state.allMonths.length;
        const ratio = Math.max(0, Math.min(1, (px - left) / width));
        return Math.round(ratio * (n - 1));
    }

    function updateBrushVisuals() {
        const lx = indexToPixel(state.rangeStart);
        const rx = indexToPixel(state.rangeEnd);
        brushLeft.style.left = (lx - 4) + "px";
        brushRight.style.left = (rx - 4) + "px";
        brushSelection.style.left = lx + "px";
        brushSelection.style.width = Math.max(0, rx - lx) + "px";
    }

    function updateRangeDisplay() {
        rangeStartEl.textContent = state.allMonths[state.rangeStart] ? formatMonth(state.allMonths[state.rangeStart]) : "";
        rangeEndEl.textContent = state.allMonths[state.rangeEnd] ? formatMonth(state.allMonths[state.rangeEnd]) : "";

        let count = 0;
        for (let i = state.rangeStart; i <= state.rangeEnd; i++) {
            count += state.timeline[i].count;
        }
        rangeEventCountEl.textContent = count.toLocaleString();
    }

    function setupBrushDrag() {
        let dragging = null; // "left" | "right" | "selection"
        let dragStartX = 0;
        let dragStartRange = [0, 0];
        let didDrag = false;

        function onPointerDown(e) {
            const target = e.target;
            if (target === brushLeft) dragging = "left";
            else if (target === brushRight) dragging = "right";
            else if (target === brushSelection) dragging = "selection";
            else return;

            if (state.singleMonthIdx >= 0) {
                state.singleMonthIdx = -1;
                currentPeriodEl.style.display = "none";
                resetChartHighlight();
            }

            didDrag = false;
            e.preventDefault();
            target.classList.add("active");
            dragStartX = e.clientX;
            dragStartRange = [state.rangeStart, state.rangeEnd];
            document.addEventListener("pointermove", onPointerMove);
            document.addEventListener("pointerup", onPointerUp);
        }

        function onPointerMove(e) {
            if (!dragging) return;
            const dx = e.clientX - dragStartX;
            if (Math.abs(dx) > 3) didDrag = true;
            const { width } = getChartArea();
            const n = state.allMonths.length;
            const dIdx = Math.round((dx / width) * (n - 1));

            if (dragging === "left") {
                state.rangeStart = Math.max(0, Math.min(state.rangeEnd, dragStartRange[0] + dIdx));
            } else if (dragging === "right") {
                state.rangeEnd = Math.max(state.rangeStart, Math.min(n - 1, dragStartRange[1] + dIdx));
            } else {
                const span = dragStartRange[1] - dragStartRange[0];
                let newStart = dragStartRange[0] + dIdx;
                newStart = Math.max(0, Math.min(n - 1 - span, newStart));
                state.rangeStart = newStart;
                state.rangeEnd = newStart + span;
            }

            updateBrushVisuals();
            updateRangeDisplay();
            updateHeatmap();
        }

        function onPointerUp() {
            dragging = null;
            brushLeft.classList.remove("active");
            brushRight.classList.remove("active");
            document.removeEventListener("pointermove", onPointerMove);
            document.removeEventListener("pointerup", onPointerUp);
            if (didDrag) {
                // Suppress the click event that follows a drag
                brushOverlay.addEventListener("click", suppressClick, { capture: true, once: true });
            }
        }

        function suppressClick(e) {
            e.stopImmediatePropagation();
        }

        brushOverlay.addEventListener("pointerdown", onPointerDown);
    }

    // ── Heatmap rendering ──────────────────────────────────────────────
    function collectHeatPoints(startIdx, endIdx) {
        const merged = {};

        for (let i = startIdx; i <= endIdx; i++) {
            const ym = state.allMonths[i];
            const year = ym.substring(0, 4);
            const month = ym.substring(5, 7);
            const yearData = state.heatmapCache[year];
            if (!yearData) continue;
            const monthData = yearData[month];
            if (!monthData) continue;

            for (const pt of monthData) {
                const key = pt[0] + "," + pt[1];
                merged[key] = (merged[key] || 0) + pt[2];
            }
        }

        const points = [];
        for (const key in merged) {
            const parts = key.split(",");
            points.push([parseFloat(parts[0]), parseFloat(parts[1]), merged[key]]);
        }
        return points;
    }

    const HEAT_GRADIENT = {
        0.0: "#00204a",
        0.2: "#1368aa",
        0.4: "#4ea8de",
        0.5: "#48e5c2",
        0.6: "#f3e37c",
        0.75: "#f0a030",
        0.9: "#e84030",
        1.0: "#ff1a1a",
    };

    function getHeatOpts() {
        const zoom = map.getZoom();
        const gridPixels = 256 * Math.pow(2, zoom) * 0.5 / 360;
        const radius = Math.max(15, Math.round(gridPixels * 1.5));
        const blur = Math.max(15, Math.round(radius * 1.0));
        const overlapRatio = (radius + blur * 0.5) / Math.max(1, gridPixels);
        return {
            radius: radius,
            blur: blur,
            minOpacity: 0.12,
            max: Math.max(1.0, overlapRatio * 0.6),
            gradient: HEAT_GRADIENT,
        };
    }

    let lastHeatPoints = null;

    function jitterCoord(lat, lon) {
        const h1 = Math.sin(lat * 12.9898 + lon * 78.233) * 43758.5453;
        const h2 = Math.sin(lat * 78.233 + lon * 12.9898) * 43758.5453;
        return [
            lat + (h1 - Math.floor(h1) - 0.5) * 0.4,
            lon + (h2 - Math.floor(h2) - 0.5) * 0.4,
        ];
    }

    function renderHeatLayer(points) {
        if (heatLayer) {
            map.removeLayer(heatLayer);
            heatLayer = null;
        }
        if (state.detailMode) return;
        if (!points || points.length === 0) return;

        const logPoints = points.map(p => {
            const [jLat, jLon] = jitterCoord(p[0], p[1]);
            return [jLat, jLon, Math.log1p(p[2])];
        });
        const sortedVals = logPoints.map(p => p[2]).sort((a, b) => a - b);
        const p95 = sortedVals[Math.floor(sortedVals.length * 0.95)] || 1;
        const scaled = logPoints.map(p => [p[0], p[1], p[2] / p95]);

        heatLayer = L.heatLayer(scaled, getHeatOpts()).addTo(map);
    }

    function updateHeatmap() {
        lastHeatPoints = collectHeatPoints(state.rangeStart, state.rangeEnd);
        if (state.detailMode) {
            updateDetailLayer();
        } else {
            renderHeatLayer(lastHeatPoints);
        }
    }

    // ── Detail tile layer (zoom >= DETAIL_ZOOM) ──────────────────────────
    let eventLayer = L.geoJSON(null, {
        style: () => ({
            color: "#4da6ff",
            weight: 1.5,
            opacity: 0.8,
            fillColor: "#4da6ff",
            fillOpacity: 0.25,
        }),
        pointToLayer: (feature, latlng) =>
            L.circleMarker(latlng, { radius: 6, color: "#4da6ff", weight: 1.5,
                                      fillColor: "#4da6ff", fillOpacity: 0.3 }),
        onEachFeature: (feature, layer) => {
            layer.on("click", () => {
                const p = feature.properties;
                const popup = L.popup({ className: "event-popup" })
                    .setContent(
                        `<b>Flood Event</b><br>` +
                        `<b>UUID:</b> <code>${p.uuid}</code><br>` +
                        `<b>Start:</b> ${p.start_date}<br>` +
                        `<b>End:</b> ${p.end_date}<br>` +
                        `<b>Area:</b> ${p.area_km2.toLocaleString()} km²`
                    );
                layer.bindPopup(popup).openPopup();
            });
            layer.on("mouseover", () => {
                layer.setStyle({ fillOpacity: 0.5, weight: 2.5, color: "#f0c040" });
            });
            layer.on("mouseout", () => {
                layer.setStyle({ fillOpacity: 0.25, weight: 1.5, color: "#4da6ff" });
            });
        },
    }).addTo(map);

    async function fetchTile(key) {
        if (state.tileCache[key]) return state.tileCache[key];
        if (state.loadingTiles[key]) return state.loadingTiles[key];

        const promise = (async () => {
            try {
                const resp = await fetch(`data/tiles/${key}.json.gz`);
                if (!resp.ok) return [];
                const ds = new DecompressionStream("gzip");
                const decompressed = resp.body.pipeThrough(ds);
                const text = await new Response(decompressed).text();
                const data = JSON.parse(text);
                state.tileCache[key] = data;
                return data;
            } catch {
                return [];
            } finally {
                delete state.loadingTiles[key];
            }
        })();
        state.loadingTiles[key] = promise;
        return promise;
    }

    function getVisibleTileKeys() {
        const bounds = map.getBounds();
        const keys = [];
        const latMin = Math.floor(bounds.getSouth());
        const latMax = Math.floor(bounds.getNorth());
        const lonMin = Math.floor(bounds.getWest());
        const lonMax = Math.floor(bounds.getEast());
        for (let lat = latMin; lat <= latMax; lat++) {
            for (let lon = lonMin; lon <= lonMax; lon++) {
                const key = `${lat}_${lon}`;
                if (state.tileIndex[key]) keys.push(key);
            }
        }
        return keys;
    }

    function getActiveTimeRange() {
        if (state.singleMonthIdx >= 0) {
            const m = state.allMonths[state.singleMonthIdx];
            return { start: m, end: m };
        }
        return {
            start: state.allMonths[state.rangeStart],
            end: state.allMonths[state.rangeEnd],
        };
    }

    function eventInTimeRange(ev, range) {
        // ev: [uuid, start_date, end_date, area, type, coords]
        const evStart = ev[1].substring(0, 7); // "YYYY-MM"
        const evEnd = ev[2].substring(0, 7);
        return evEnd >= range.start && evStart <= range.end;
    }

    function compactToGeoJSON(ev) {
        const typeCode = ev[4];
        const coords = ev[5];
        const typeName = TYPE_NAMES[typeCode] || "Polygon";
        return {
            type: "Feature",
            geometry: { type: typeName, coordinates: coords },
            properties: {
                uuid: ev[0],
                start_date: ev[1],
                end_date: ev[2],
                area_km2: ev[3],
            },
        };
    }

    async function updateDetailLayer() {
        eventLayer.clearLayers();
        if (map.getZoom() < DETAIL_ZOOM) return;

        const keys = getVisibleTileKeys();
        const range = getActiveTimeRange();
        const tiles = await Promise.all(keys.map(k => fetchTile(k)));
        const features = [];

        for (const tileEvents of tiles) {
            for (const ev of tileEvents) {
                if (eventInTimeRange(ev, range)) {
                    features.push(compactToGeoJSON(ev));
                }
            }
        }

        eventLayer.addData({ type: "FeatureCollection", features });
    }

    function switchLayer() {
        const zoom = map.getZoom();
        if (zoom >= DETAIL_ZOOM && !state.detailMode) {
            state.detailMode = true;
            if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
            updateDetailLayer();
        } else if (zoom < DETAIL_ZOOM && state.detailMode) {
            state.detailMode = false;
            eventLayer.clearLayers();
            renderHeatLayer(lastHeatPoints);
        } else if (state.detailMode) {
            updateDetailLayer();
        } else {
            // Heatmap mode, zoom changed → recreate with updated radius
            renderHeatLayer(lastHeatPoints);
        }
    }

    // ── Animation ──────────────────────────────────────────────────────
    function getAnimationDelay() {
        const speed = parseInt(speedSlider.value);
        return 1100 - speed * 100; // 200ms (fast) to 1000ms (slow)
    }

    function startAnimation() {
        if (state.animating) return;
        state.animating = true;
        btnPlay.classList.add("hidden");
        btnPause.classList.remove("hidden");
        currentPeriodEl.style.display = "block";

        if (state.singleMonthIdx >= 0) {
            state.animationIdx = state.singleMonthIdx;
            state.singleMonthIdx = -1;
        } else {
            state.animationIdx = state.rangeStart;
        }
        animateStep();
    }

    function animateStep() {
        if (!state.animating) return;
        if (state.animationIdx > state.rangeEnd) {
            stopAnimation();
            return;
        }

        const ym = state.allMonths[state.animationIdx];
        currentPeriodEl.textContent = formatMonth(ym);

        // Temporarily set singleMonthIdx so detail layer filters to this month
        state.singleMonthIdx = state.animationIdx;

        lastHeatPoints = collectHeatPoints(state.animationIdx, state.animationIdx);
        if (state.detailMode) {
            updateDetailLayer();
        } else {
            renderHeatLayer(lastHeatPoints);
        }

        highlightChartBar(state.animationIdx);

        state.animationIdx++;
        state.animationTimer = setTimeout(animateStep, getAnimationDelay());
    }

    function stopAnimation() {
        state.animating = false;
        state.singleMonthIdx = -1;
        btnPlay.classList.remove("hidden");
        btnPause.classList.add("hidden");
        currentPeriodEl.style.display = "none";

        if (state.animationTimer) {
            clearTimeout(state.animationTimer);
            state.animationTimer = null;
        }

        resetChartHighlight();
        updateHeatmap();
    }

    function highlightChartBar(idx) {
        if (!chart) return;
        const ds = chart.data.datasets[0];
        const n = state.allMonths.length;
        const colors = new Array(n).fill("rgba(77, 166, 255, 0.15)");
        const borders = new Array(n).fill("rgba(77, 166, 255, 0.2)");
        colors[idx] = "rgba(255, 100, 60, 0.9)";
        borders[idx] = "rgba(255, 100, 60, 1)";
        ds.backgroundColor = colors;
        ds.borderColor = borders;
        chart.update("none");
    }

    function resetChartHighlight() {
        if (!chart) return;
        const ds = chart.data.datasets[0];
        ds.backgroundColor = "rgba(77, 166, 255, 0.5)";
        ds.borderColor = "rgba(77, 166, 255, 0.8)";
        chart.update("none");
    }

    function formatMonth(ym) {
        const months = ["January", "February", "March", "April", "May", "June",
                        "July", "August", "September", "October", "November", "December"];
        const parts = ym.split("-");
        return months[parseInt(parts[1]) - 1] + " " + parts[0];
    }

    // ── Data loading ───────────────────────────────────────────────────
    async function loadTimeline() {
        const resp = await fetch("data/timeline.json");
        return resp.json();
    }

    async function loadHeatmapYear(year) {
        if (state.heatmapCache[year]) return;
        const resp = await fetch(`data/heatmap/${year}.json`);
        state.heatmapCache[year] = await resp.json();
    }

    async function loadTileIndex() {
        const resp = await fetch("data/tiles/index.json");
        return resp.json();
    }

    async function loadAllData() {
        const [timeline, tileIndex] = await Promise.all([loadTimeline(), loadTileIndex()]);
        state.timeline = timeline;
        state.tileIndex = tileIndex;
        state.allMonths = state.timeline.map(d => d.month);
        state.totalEvents = state.timeline.reduce((s, d) => s + d.count, 0);

        const years = [...new Set(state.allMonths.map(m => m.substring(0, 4)))];
        await Promise.all(years.map(y => loadHeatmapYear(y)));
    }

    // ── Info overlay ──────────────────────────────────────────────────
    const INFO_SEEN_KEY = "groundsourceInfoSeen";

    function openInfoOverlay() {
        if (infoOverlay) {
            infoOverlay.classList.remove("hidden");
            infoOverlay.setAttribute("aria-hidden", "false");
        }
    }

    function closeInfoOverlay() {
        if (infoOverlay) {
            infoOverlay.classList.add("hidden");
            infoOverlay.setAttribute("aria-hidden", "true");
            try { sessionStorage.setItem(INFO_SEEN_KEY, "1"); } catch (_) {}
        }
    }

    function maybeShowInfoOnFirstVisit() {
        try {
            if (!sessionStorage.getItem(INFO_SEEN_KEY)) openInfoOverlay();
        } catch (_) {}
    }

    // ── Event bindings ─────────────────────────────────────────────────
    if (linkInfo) linkInfo.addEventListener("click", (e) => { e.preventDefault(); openInfoOverlay(); });
    if (infoOverlayClose) infoOverlayClose.addEventListener("click", closeInfoOverlay);
    if (infoOverlayBackdrop) infoOverlayBackdrop.addEventListener("click", closeInfoOverlay);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && infoOverlay && !infoOverlay.classList.contains("hidden")) closeInfoOverlay(); });

    btnPlay.addEventListener("click", startAnimation);
    btnPause.addEventListener("click", stopAnimation);
    btnReset.addEventListener("click", () => {
        stopAnimation();
        state.singleMonthIdx = -1;
        currentPeriodEl.style.display = "none";
        state.rangeStart = 0;
        state.rangeEnd = state.allMonths.length - 1;
        resetChartHighlight();
        updateBrushVisuals();
        updateRangeDisplay();
        updateHeatmap();
    });

    speedSlider.addEventListener("input", () => {
        if (state.animating) {
            clearTimeout(state.animationTimer);
            state.animationTimer = setTimeout(animateStep, getAnimationDelay());
        }
    });

    // Click on the timeline (brush overlay captures pointer, so we listen there)
    brushOverlay.addEventListener("click", handleTimelineClick);

    map.on("zoomend", () => switchLayer());
    map.on("moveend", () => { if (state.detailMode) updateDetailLayer(); });

    window.addEventListener("resize", () => {
        if (chart) {
            chart.options.scales.x.ticks.maxTicksLimit = getMaxYearTicks();
            chart.resize();
            chart.update("none");
            updateBrushVisuals();
        }
    });

    // ── Init ───────────────────────────────────────────────────────────
    async function init() {
        await loadAllData();

        statEvents.textContent = state.totalEvents.toLocaleString();
        const firstMonth = state.allMonths[0];
        const lastMonth = state.allMonths[state.allMonths.length - 1];
        statRange.textContent = `${formatMonth(firstMonth)} to ${formatMonth(lastMonth)}`;

        state.rangeStart = 0;
        state.rangeEnd = state.allMonths.length - 1;

        initChart(
            state.allMonths,
            state.timeline.map(d => d.count)
        );

        // Wait for layout to settle before rendering
        requestAnimationFrame(() => {
            map.invalidateSize();
            updateBrushVisuals();
            setupBrushDrag();
            updateRangeDisplay();
            updateHeatmap();

            loadingOverlay.classList.add("fade-out");
            setTimeout(() => {
                loadingOverlay.remove();
                setTimeout(maybeShowInfoOnFirstVisit, 400);
            }, 500);
        });
    }

    init().catch(err => {
        console.error("Failed to initialize:", err);
        $("#loading-text").textContent = "Error loading data. Check console.";
    });
})();
