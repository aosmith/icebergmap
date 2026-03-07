// Leaflet map for displaying sighting pins

let map = null;
let markerCluster = null;
let initialized = false;

const TYPE_COLORS = {
    checkpoint: '#ff6b6b',
    raid: '#ff4444',
    patrol: '#ffaa33',
    arrest: '#ff2222',
    surveillance: '#9966ff',
    other: '#8888aa'
};

function createIcon(type) {
    const color = TYPE_COLORS[type] || TYPE_COLORS.other;
    return L.divIcon({
        className: 'sighting-marker',
        html: `<div style="
            width: 14px; height: 14px;
            background: ${color};
            border: 2px solid #fff;
            border-radius: 50%;
            box-shadow: 0 2px 6px rgba(0,0,0,0.4);
        "></div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
        popupAnchor: [0, -10]
    });
}

export function initMap() {
    if (initialized) return;

    map = L.map('map', {
        center: [39.8283, -98.5795], // Center of US
        zoom: 4,
        zoomControl: true,
        attributionControl: true
    });

    // Dark tile layer
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://openstreetmap.org/copyright">OSM</a>',
        maxZoom: 19
    }).addTo(map);

    markerCluster = L.markerClusterGroup({
        maxClusterRadius: 50,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
        iconCreateFunction: (cluster) => {
            const count = cluster.getChildCount();
            return L.divIcon({
                html: `<div style="
                    background: rgba(74, 158, 255, 0.8);
                    color: #fff;
                    border-radius: 50%;
                    width: 36px; height: 36px;
                    display: flex; align-items: center; justify-content: center;
                    font-weight: 600; font-size: 13px;
                    border: 2px solid rgba(255,255,255,0.3);
                    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
                ">${count}</div>`,
                className: 'marker-cluster-custom',
                iconSize: [36, 36]
            });
        }
    });

    map.addLayer(markerCluster);
    initialized = true;
}

export function updateMapSightings(sightings) {
    if (!markerCluster) return;

    markerCluster.clearLayers();

    for (const s of sightings) {
        if (s.latitude == null || s.longitude == null) continue;

        const marker = L.marker([s.latitude, s.longitude], {
            icon: createIcon(s.report_type)
        });

        const time = formatRelativeTime(s.sighted_at || s.created_at);
        const location = s.location_name || `${s.latitude.toFixed(4)}, ${s.longitude.toFixed(4)}`;

        marker.bindPopup(`
            <div style="min-width: 200px">
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
                    <span style="
                        background: ${TYPE_COLORS[s.report_type] || TYPE_COLORS.other};
                        color: #fff; padding: 2px 8px; border-radius: 10px;
                        font-size: 11px; font-weight: 600; text-transform: uppercase;
                    ">${s.report_type}</span>
                    <span style="color: #888; font-size: 12px">${time}</span>
                </div>
                <div style="font-size: 13px; margin-bottom: 4px"><strong>${location}</strong></div>
                <div style="font-size: 13px; color: #ccc">${s.description.substring(0, 200)}${s.description.length > 200 ? '...' : ''}</div>
                ${s.agent_count ? `<div style="color: #ffaa33; font-size: 12px; margin-top: 4px">${s.agent_count} agent${s.agent_count > 1 ? 's' : ''}</div>` : ''}
            </div>
        `);

        markerCluster.addLayer(marker);
    }
}

export function invalidateMap() {
    if (map) {
        setTimeout(() => map.invalidateSize(), 100);
    }
}

function formatRelativeTime(dateStr) {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
}
