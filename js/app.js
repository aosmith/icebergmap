// Iceberg Map — Anonymous P2P ICE Sighting Reports
// No accounts. No servers. No tracking.

const _h = window.__cb || Date.now().toString(36);
const { openDB, saveSighting, getSightings, getSightingCount, getConfirmationCounts, saveConfirmation, purgeOldSightings, clearAllData, getLocalVote } = await import(`./db.js?h=${_h}`);
const { initNetwork, publishSighting, publishConfirmation, getPeerCount, getBlockedCount, getNetworkStats, onConsoleLog } = await import(`./network.js?h=${_h}`);
const { initMap, updateMapSightings, invalidateMap } = await import(`./map.js?h=${_h}`);
const { stripMetadata } = await import(`./media.js?h=${_h}`);

const US_STATES = [
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
    'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
    'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
    'VA','WA','WV','WI','WY','DC','PR'
];

const TYPE_LABELS = {
    checkpoint: 'Checkpoint',
    raid: 'Raid',
    patrol: 'Patrol',
    arrest: 'Arrest',
    surveillance: 'Surveillance',
    other: 'Other'
};

let currentView = 'feed';
let mapInitialized = false;
let strippedPhotos = []; // accumulated stripped photos for current report
let networkModalInterval = null;
let consoleEnabled = false;

async function init() {
    await openDB();
    populateStateDropdowns();
    setupNavigation();
    setupModal();
    setupReportForm();
    setupSettings();
    setupFilters();
    setupNetworkModal();

    // Initialize P2P network
    await initNetwork({
        onSighting: () => refreshCurrentView(),
        onPeerCount: (count) => updatePeerCount(count)
    });

    // Initial render
    await refreshFeed();

    // Purge old data on startup
    const retention = localStorage.getItem('retention_days') || '30';
    await purgeOldSightings(parseInt(retention));
}

function populateStateDropdowns() {
    const selects = [document.getElementById('filter-state'), document.getElementById('report-state')];
    for (const select of selects) {
        for (const st of US_STATES) {
            const opt = document.createElement('option');
            opt.value = st;
            opt.textContent = st;
            select.appendChild(opt);
        }
    }
}

// --- Navigation ---

function setupNavigation() {
    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.addEventListener('click', () => switchView(tab.dataset.view));
    });
}

function switchView(view) {
    currentView = view;
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.nav-tab[data-view="${view}"]`).classList.add('active');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(`view-${view}`).classList.add('active');

    if (view === 'map') {
        if (!mapInitialized) { initMap(); mapInitialized = true; }
        invalidateMap();
        refreshMap();
    } else if (view === 'feed') {
        refreshFeed();
    } else if (view === 'settings') {
        refreshSettings();
    }
}

// --- Report Modal ---

function setupModal() {
    const modal = document.getElementById('report-modal');
    const openBtn = document.getElementById('btn-report');
    const closeBtn = document.getElementById('modal-close');

    openBtn.addEventListener('click', () => openModal());

    closeBtn.addEventListener('click', () => closeModal());

    // Close on backdrop click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modal.hidden) closeModal();
    });

    // Photo drop zone drag handling
    const dropZone = document.getElementById('photo-drop');
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        handlePhotos(e.dataTransfer.files);
    });

    // File input change
    document.getElementById('report-photo').addEventListener('change', (e) => {
        handlePhotos(e.target.files);
    });
}

function openModal() {
    const modal = document.getElementById('report-modal');
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    strippedPhotos = [];
    document.getElementById('photo-preview').innerHTML = '';

    // Default time to now
    document.getElementById('report-time').value = new Date().toISOString().slice(0, 16);

    // Focus the title field
    setTimeout(() => document.getElementById('report-title').focus(), 100);
}

function closeModal() {
    const modal = document.getElementById('report-modal');
    modal.hidden = true;
    document.body.style.overflow = '';
    document.getElementById('report-form').reset();
    document.getElementById('report-lat').value = '';
    document.getElementById('report-lng').value = '';
    strippedPhotos = [];
    document.getElementById('photo-preview').innerHTML = '';
}

async function handlePhotos(files) {
    const preview = document.getElementById('photo-preview');
    const dropText = document.querySelector('.photo-drop-text');

    for (const file of files) {
        if (!file.type.startsWith('image/')) continue;
        try {
            const { dataUrl } = await stripMetadata(file);
            strippedPhotos.push(dataUrl);

            const img = document.createElement('img');
            img.src = dataUrl;
            preview.appendChild(img);
        } catch (err) {
            console.error('Failed to process photo:', err);
        }
    }

    if (strippedPhotos.length > 0) {
        dropText.textContent = `${strippedPhotos.length} photo${strippedPhotos.length > 1 ? 's' : ''} (metadata stripped)`;
    }
}

// --- Filters ---

function setupFilters() {
    document.getElementById('filter-type').addEventListener('change', refreshFeed);
    document.getElementById('filter-state').addEventListener('change', refreshFeed);
}

// --- Feed ---

async function refreshFeed() {
    const type = document.getElementById('filter-type').value;
    const state = document.getElementById('filter-state').value;
    const sightings = await getSightings({ type, state, limit: 200 });
    const list = document.getElementById('sighting-list');

    if (sightings.length === 0) {
        list.innerHTML = '<div class="empty-state">No sightings yet. Be the first to report.</div>';
        return;
    }

    const cards = [];
    for (const s of sightings) {
        const counts = await getConfirmationCounts(s.id);
        const localVote = await getLocalVote(s.id);
        cards.push(renderSightingCard(s, counts, localVote));
    }
    list.innerHTML = cards.join('');

    // Attach confirm/dispute handlers
    list.querySelectorAll('.btn-confirm').forEach(btn => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); handleConfirmation(btn.dataset.id, true); });
    });
    list.querySelectorAll('.btn-dispute').forEach(btn => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); handleConfirmation(btn.dataset.id, false); });
    });
}

function getTrustClass(counts) {
    const { confirms, disputes } = counts;
    if (confirms >= 3 && confirms > disputes * 2) return 'trust-verified';
    if (disputes >= 3 && disputes > confirms * 2) return 'trust-disputed';
    return '';
}

function renderSightingCard(s, counts, localVote) {
    const time = formatRelativeTime(s.sighted_at || s.created_at);
    const location = s.location_name || (s.state ? s.state : '');
    const title = s.title || s.description.substring(0, 60);
    const hasPhotos = s.photos && s.photos.length > 0;
    const trustClass = getTrustClass(counts);
    const hasVoted = localVote !== null;
    const confirmBtnClass = hasVoted ? (localVote === true ? 'voted voted-yes' : 'voted') : '';
    const disputeBtnClass = hasVoted ? (localVote === false ? 'voted voted-no' : 'voted') : '';

    return `
        <div class="sighting-card ${trustClass}" data-id="${s.id}">
            <div class="sighting-card-header">
                <span class="type-badge ${s.report_type}">${TYPE_LABELS[s.report_type] || s.report_type}</span>
                <span class="sighting-location">${escapeHtml(location)}</span>
                <span class="sighting-time">${time}</span>
            </div>
            <div class="sighting-title">${escapeHtml(title)}</div>
            <div class="sighting-description">${escapeHtml(s.description)}</div>
            ${hasPhotos ? `<div class="sighting-photos">${s.photos.map(p => `<img src="${p}" alt="Evidence">`).join('')}</div>` : ''}
            <div class="sighting-meta">
                ${s.agent_count ? `<span class="agents">${s.agent_count} agent${s.agent_count > 1 ? 's' : ''}</span>` : ''}
                ${s.vehicle_description ? `<span>${escapeHtml(s.vehicle_description)}</span>` : ''}
                ${s.state ? `<span>${s.state}</span>` : ''}
            </div>
            <div class="sighting-actions">
                <button class="btn-confirm ${confirmBtnClass}" data-id="${s.id}" ${hasVoted ? 'disabled' : ''}>
                    ${localVote === true ? 'Confirmed' : 'Confirm'} <span class="confirm-count">(${counts.confirms})</span>
                </button>
                <button class="btn-dispute ${disputeBtnClass}" data-id="${s.id}" ${hasVoted ? 'disabled' : ''}>
                    ${localVote === false ? 'Disputed' : 'Dispute'} <span class="dispute-count">(${counts.disputes})</span>
                </button>
            </div>
        </div>
    `;
}

async function handleConfirmation(sightingId, confirmed) {
    const existingVote = await getLocalVote(sightingId);
    if (existingVote !== null) {
        showToast('You already voted on this sighting', 'error');
        return;
    }

    const confId = `local_${sightingId}_${Date.now()}`;
    await saveConfirmation({
        id: confId,
        sighting_id: sightingId,
        confirmed,
        created_at: new Date().toISOString()
    });
    publishConfirmation(sightingId, confirmed);
    showToast(confirmed ? 'Sighting confirmed' : 'Sighting disputed', 'success');
    await refreshFeed();
}

// --- Map ---

async function refreshMap() {
    const sightings = await getSightings({ limit: 1000 });
    const withLocation = sightings.filter(s => s.latitude != null && s.longitude != null);
    updateMapSightings(withLocation);
}

// --- Report Form ---

function setupReportForm() {
    const form = document.getElementById('report-form');
    const gpsBtn = document.getElementById('use-gps');

    gpsBtn.addEventListener('click', () => {
        if (!navigator.geolocation) {
            showToast('Geolocation not available', 'error');
            return;
        }
        gpsBtn.textContent = 'Locating...';
        gpsBtn.disabled = true;

        navigator.geolocation.getCurrentPosition(
            (pos) => {
                document.getElementById('report-lat').value = pos.coords.latitude;
                document.getElementById('report-lng').value = pos.coords.longitude;
                document.getElementById('report-location').value =
                    `${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)}`;
                gpsBtn.textContent = 'Location set';
                setTimeout(() => { gpsBtn.textContent = 'Use my location'; gpsBtn.disabled = false; }, 2000);
            },
            (err) => {
                showToast('Could not get location: ' + err.message, 'error');
                gpsBtn.textContent = 'Use my location';
                gpsBtn.disabled = false;
            },
            { enableHighAccuracy: false, timeout: 10000 }
        );
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        await submitReport();
    });
}

async function submitReport() {
    const form = document.getElementById('report-form');
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    try {
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const lat = document.getElementById('report-lat').value;
        const lng = document.getElementById('report-lng').value;

        const sighting = {
            id,
            title: document.getElementById('report-title').value,
            report_type: document.getElementById('report-type').value,
            description: document.getElementById('report-description').value,
            latitude: lat ? parseFloat(lat) : null,
            longitude: lng ? parseFloat(lng) : null,
            location_name: document.getElementById('report-location').value || null,
            state: document.getElementById('report-state').value || null,
            agent_count: parseInt(document.getElementById('report-agents').value) || null,
            vehicle_description: document.getElementById('report-vehicles').value || null,
            sighted_at: document.getElementById('report-time').value
                ? new Date(document.getElementById('report-time').value).toISOString()
                : now,
            created_at: now,
            received_at: now,
            photos: strippedPhotos.length > 0 ? strippedPhotos : null
        };

        // Store locally (identical to received — no "is_mine" flag)
        await saveSighting(sighting);

        // Broadcast with random delay
        publishSighting(sighting);

        closeModal();
        showToast('Report submitted anonymously', 'success');
        await refreshFeed();
    } catch (err) {
        showToast('Failed to submit: ' + err.message, 'error');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Report';
    }
}

// --- Settings ---

function setupSettings() {
    const retention = document.getElementById('settings-retention');
    retention.value = localStorage.getItem('retention_days') || '30';
    retention.addEventListener('change', () => localStorage.setItem('retention_days', retention.value));

    document.getElementById('btn-clear-data').addEventListener('click', async () => {
        if (confirm('This will delete all locally stored sightings. Are you sure?')) {
            await clearAllData();
            showToast('All local data cleared', 'success');
            refreshCurrentView();
        }
    });
}

async function refreshSettings() {
    const count = await getSightingCount();
    document.getElementById('settings-sighting-count').textContent = count;
    document.getElementById('settings-peer-count').textContent = getPeerCount();
    document.getElementById('settings-blocked-count').textContent = getBlockedCount();
}

function updatePeerCount(count) {
    document.getElementById('peer-count').textContent = `${count} peer${count !== 1 ? 's' : ''}`;
    document.getElementById('settings-peer-count').textContent = count;
}

// --- Network Info Modal ---

function setupNetworkModal() {
    const modal = document.getElementById('network-modal');
    const closeBtn = document.getElementById('network-modal-close');

    document.getElementById('peer-count').addEventListener('click', () => openNetworkModal());
    closeBtn.addEventListener('click', () => closeNetworkModal());
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeNetworkModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modal.hidden) closeNetworkModal();
    });

    // Console mode
    document.getElementById('btn-console-mode').addEventListener('click', () => {
        toggleConsole();
        closeNetworkModal();
    });
    document.getElementById('console-close').addEventListener('click', () => toggleConsole());
}

function openNetworkModal() {
    const modal = document.getElementById('network-modal');
    modal.hidden = false;
    refreshNetworkStats();
    // Refresh stats every 2 seconds while modal is open
    networkModalInterval = setInterval(refreshNetworkStats, 2000);
}

function closeNetworkModal() {
    document.getElementById('network-modal').hidden = true;
    if (networkModalInterval) {
        clearInterval(networkModalInterval);
        networkModalInterval = null;
    }
}

function refreshNetworkStats() {
    const stats = getNetworkStats();
    document.getElementById('stat-status').textContent = stats.peers > 0 ? 'Connected' : 'Searching for peers...';
    document.getElementById('stat-status').style.color = stats.peers > 0 ? 'var(--success)' : 'var(--warning)';
    document.getElementById('stat-peers').textContent = stats.peers;
    document.getElementById('stat-uptime').textContent = stats.uptime;
    document.getElementById('stat-protocol').textContent = stats.protocol;
    document.getElementById('stat-received').textContent = stats.sightingsReceived;
    document.getElementById('stat-sent').textContent = stats.sightingsSent;
    document.getElementById('stat-syncs').textContent = stats.syncsCompleted;
    document.getElementById('stat-seen').textContent = stats.seenMessages;
    document.getElementById('stat-blocked').textContent = stats.blocked;
}

// --- Console Mode ---

function toggleConsole() {
    const overlay = document.getElementById('console-overlay');
    consoleEnabled = !consoleEnabled;
    overlay.hidden = !consoleEnabled;

    const btn = document.getElementById('btn-console-mode');
    if (consoleEnabled) {
        btn.textContent = 'Disable Console Mode';
        onConsoleLog((tag, msg) => appendConsoleLine(tag, msg));
        appendConsoleLine('info', 'Console mode enabled');
    } else {
        btn.textContent = 'Enable Console Mode';
        onConsoleLog(null);
    }
}

function appendConsoleLine(tag, msg) {
    const output = document.getElementById('console-output');
    if (!output) return;

    const line = document.createElement('div');
    line.className = 'log-line';

    const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    line.innerHTML = `<span class="log-time">${time}</span> <span class="log-tag ${escapeHtml(tag)}">[${escapeHtml(tag.toUpperCase())}]</span> ${escapeHtml(msg)}`;

    output.appendChild(line);
    output.scrollTop = output.scrollHeight;

    // Cap at 500 lines
    while (output.children.length > 500) {
        output.removeChild(output.firstChild);
    }
}

async function refreshCurrentView() {
    if (currentView === 'feed') await refreshFeed();
    else if (currentView === 'map') await refreshMap();
    else if (currentView === 'settings') await refreshSettings();
}

// --- Utilities ---

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

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function showToast(message, type = '') {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// Boot
init().catch(err => console.error('Failed to initialize:', err));
