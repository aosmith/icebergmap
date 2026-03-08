// P2P networking via Trystero (Nostr relay matchmaking + WebRTC)
// All messages are anonymous — no peer IDs, no identity, just sighting data

import { joinRoom, getRelaySockets, selfId } from 'https://esm.run/trystero@0.20.1';
const _h = window.__cb || Date.now().toString(36);
const { saveSighting, sightingExists, saveConfirmation, getAllSightingIds, getSightingsById, estimatePhotoStorage, evictOldestPhotos, getAllConfirmationIds, getConfirmationsById } = await import(`./db.js?h=${_h}`);
const { checkFederalIP, extractIPsFromCandidate } = await import(`./cidr.js?h=${_h}`);
const { reencodePhoto } = await import(`./media.js?h=${_h}`);

const APP_ID = 'icebergmap-anonymous-sightings-v1';
const ROOM_NAME = 'sightings';

// Sync limits
const MAX_SYNC_SIGHTINGS = 200;
const MAX_SYNC_IDS = 2000;
const MAX_PHOTOS_PER_SIGHTING = 3;
const MAX_PHOTO_BYTES = 200 * 1024;
const MAX_SIGHTING_TEXT_BYTES = 8 * 1024;
const PHOTO_BACKOFF_BASE_MS = 2000;
const PHOTO_BACKOFF_MAX_MS = 60000;
const MAX_PHOTO_STORAGE_BYTES = 50 * 1024 * 1024;
const MAX_SYNC_CONFIRMATIONS = 500;
const MAX_SYNC_CONF_IDS = 5000;
const SYNC_COOLDOWN_MS = 60000;

let room = null;
let sendSighting = null;
let sendConfirmation = null;
let sendSyncIds = null;
let sendSyncData = null;
let sendSyncConfIds = null;
let sendSyncConfData = null;
let peerCount = 0;
let blockedCount = 0;
let onPeerCountChange = null;
let onSightingReceived = null;
let networkStartTime = null;
let sightingsReceived = 0;
let sightingsSent = 0;
let syncCompletedCount = 0;
let consoleCallback = null;
const earlyLogs = [];

// Track seen message IDs to prevent infinite re-broadcast
const seenMessages = new Set();
const MAX_SEEN = 5000;

// Per-peer sync state
const peerSyncState = new Map();

function netLog(tag, msg) {
    console.log(`[P2P] [${tag}] ${msg}`);
    if (consoleCallback) {
        consoleCallback(tag, msg);
    } else {
        earlyLogs.push({ tag, msg, time: Date.now() });
        if (earlyLogs.length > 50) earlyLogs.shift();
    }
}

function addSeen(id) {
    seenMessages.add(id);
    if (seenMessages.size > MAX_SEEN) {
        const first = seenMessages.values().next().value;
        seenMessages.delete(first);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function estimateSightingTextSize(data) {
    const copy = { ...data, photos: null };
    return new Blob([JSON.stringify(copy)]).size;
}

/**
 * Validate, limit, and re-encode photos through canvas.
 * Defuses image parser exploits and enforces size limits.
 * @returns {Promise<string[]|null>} Cleaned photo array or null
 */
async function cleanPhotos(photos) {
    if (!Array.isArray(photos)) return null;

    const clean = [];
    for (const photo of photos.slice(0, MAX_PHOTOS_PER_SIGHTING)) {
        try {
            const reencoded = await reencodePhoto(photo, MAX_PHOTO_BYTES);
            clean.push(reencoded);
        } catch {
            // Skip invalid or oversized photos
        }
    }
    return clean.length > 0 ? clean : null;
}

/**
 * Initialize P2P network.
 * @param {{ onSighting: Function, onPeerCount: Function }} callbacks
 */
export function initNetwork({ onSighting, onPeerCount }) {
    onSightingReceived = onSighting;
    onPeerCountChange = onPeerCount;

    netLog('info', `Joining room: ${APP_ID} / ${ROOM_NAME}`);

    try {
        room = joinRoom(
            { appId: APP_ID },
            ROOM_NAME,
            (err) => netLog('block', `Join error: ${typeof err === 'object' ? JSON.stringify(err) : err}`)
        );
    } catch (err) {
        netLog('block', `Failed to join room: ${err.message}`);
        return;
    }

    netLog('info', `Our peer ID: ${selfId}`);

    // Monitor relay WebSocket traffic
    setTimeout(() => {
        try {
            const sockets = getRelaySockets();
            const urls = Object.keys(sockets);
            netLog('ws', `Relay sockets: ${urls.length}`);
            let openCount = 0;
            for (const [url, socket] of Object.entries(sockets)) {
                const host = new URL(url).hostname;
                if (socket.readyState === 1) openCount++;

                // Intercept outgoing sends
                const origSend = socket.send.bind(socket);
                socket.send = (data) => {
                    try {
                        const msg = JSON.parse(data);
                        if (Array.isArray(msg)) {
                            // Nostr format: ["EVENT", {...}] or ["REQ", subId, filter]
                            if (msg[0] === 'EVENT') {
                                const content = msg[1]?.content;
                                const parsed = content ? JSON.parse(content) : {};
                                if (parsed.offer) {
                                    netLog('ws', `→ ${host}: OFFER to peer`);
                                } else if (parsed.answer) {
                                    netLog('ws', `→ ${host}: ANSWER to peer`);
                                } else if (parsed.peerId) {
                                    netLog('ws', `→ ${host}: ANNOUNCE peerId=${parsed.peerId?.slice(0,8)}..`);
                                }
                            } else if (msg[0] === 'REQ') {
                                netLog('ws', `→ ${host}: SUBSCRIBE kind=${msg[2]?.kinds?.[0] || '?'}`);
                            }
                        } else if (msg.offers) {
                            // Torrent format (fallback)
                            netLog('ws', `→ ${host}: ANNOUNCE offers=${msg.offers.length}`);
                        }
                    } catch {}
                    origSend(data);
                };

                // Intercept incoming messages
                socket.addEventListener('message', (event) => {
                    try {
                        const msg = JSON.parse(event.data);
                        if (Array.isArray(msg)) {
                            if (msg[0] === 'EVENT' && msg[2]?.content) {
                                const content = JSON.parse(msg[2].content);
                                if (content.offer) {
                                    netLog('ws', `← ${host}: GOT OFFER from peer`);
                                } else if (content.answer) {
                                    netLog('ws', `← ${host}: GOT ANSWER from peer`);
                                } else if (content.peerId) {
                                    netLog('ws', `← ${host}: PEER ANNOUNCE peerId=${content.peerId?.slice(0,8)}..`);
                                }
                            } else if (msg[0] === 'NOTICE') {
                                netLog('ws', `← ${host}: NOTICE: ${msg[1]}`);
                            } else if (msg[0] === 'OK' && !msg[2]) {
                                netLog('ws', `← ${host}: REJECTED: ${msg[3] || 'unknown'}`);
                            }
                        } else if (msg.offer || msg.answer) {
                            // Torrent format (fallback)
                            netLog('ws', `← ${host}: GOT ${msg.offer ? 'OFFER' : 'ANSWER'}`);
                        }
                    } catch {}
                });
            }
            netLog('ws', `${openCount}/${urls.length} relays OPEN`);
        } catch (e) {
            netLog('ws', `Failed to attach relay monitors: ${e.message}`);
        }
    }, 3000);

    // Warn if no peers found after 15 seconds
    setTimeout(() => {
        if (peerCount === 0) {
            netLog('info', 'No peers found yet — trackers may be unreachable or no other users are online');
        }
    }, 15000);

    // Live broadcast actions
    const [_sendSighting, getSighting] = room.makeAction('sighting');
    const [_sendConfirmation, getConfirmation] = room.makeAction('confirmation');

    // Sync actions
    const [_sendSyncIds, getSyncIds] = room.makeAction('sync-ids');
    const [_sendSyncData, getSyncData] = room.makeAction('sync-data');
    const [_sendSyncConfIds, getSyncConfIds] = room.makeAction('sync-conf-ids');
    const [_sendSyncConfData, getSyncConfData] = room.makeAction('sync-conf-data');

    sendSighting = _sendSighting;
    sendConfirmation = _sendConfirmation;
    sendSyncIds = _sendSyncIds;
    sendSyncData = _sendSyncData;
    sendSyncConfIds = _sendSyncConfIds;
    sendSyncConfData = _sendSyncConfData;

    // --- Live broadcast handlers ---

    getSighting(async (data, peerId) => {
        if (seenMessages.has(data.id)) return;
        addSeen(data.id);

        const exists = await sightingExists(data.id);
        if (!exists) {
            if (data.photos) {
                data.photos = await cleanPhotos(data.photos);
            }
            data.received_at = new Date().toISOString();
            await saveSighting(data);
            sightingsReceived++;
            netLog('recv', `Sighting "${data.title || data.id}" (${data.report_type}) from peer`);
            if (onSightingReceived) onSightingReceived(data);
        }
    });

    getConfirmation(async (data) => {
        const confId = `${data.sighting_id}_${data.timestamp}`;
        if (seenMessages.has(confId)) return;
        addSeen(confId);

        await saveConfirmation({
            id: confId,
            sighting_id: data.sighting_id,
            confirmed: data.confirmed,
            created_at: new Date().toISOString()
        });

        netLog('recv', `Confirmation for ${data.sighting_id} (${data.confirmed ? 'confirm' : 'dispute'})`);
        if (onSightingReceived) onSightingReceived(null);
    });

    // --- Sync handlers ---

    // Receive peer's sighting IDs, send them what they're missing
    getSyncIds(async (theirIds, peerId) => {
        if (!Array.isArray(theirIds)) return;

        // Rate limit: one sync per peer per minute
        const state = peerSyncState.get(peerId);
        if (state && state.lastSyncSent && Date.now() - state.lastSyncSent < SYNC_COOLDOWN_MS) return;

        const ourIds = await getAllSightingIds();
        const theirIdSet = new Set(theirIds.slice(0, MAX_SYNC_IDS));
        const theyNeed = ourIds.filter(id => !theirIdSet.has(id)).slice(0, MAX_SYNC_SIGHTINGS);

        if (theyNeed.length === 0) return;

        // Update sync state
        if (!peerSyncState.has(peerId)) peerSyncState.set(peerId, {});
        peerSyncState.get(peerId).lastSyncSent = Date.now();

        // Send missing sightings with photo backoff
        syncCompletedCount++;
        netLog('sync', `Sending ${theyNeed.length} missing sightings to peer`);
        sendMissingSightings(theyNeed, peerId);
    });

    // Receive synced sighting data
    getSyncData(async (data, peerId) => {
        if (!data || !data.id || !data.description || !data.report_type) return;
        if (seenMessages.has(data.id)) return;

        // Reject oversized text payloads
        if (estimateSightingTextSize(data) > MAX_SIGHTING_TEXT_BYTES) return;

        // Handle photos with per-peer exponential backoff
        if (data.photos && data.photos.length > 0) {
            if (!peerSyncState.has(peerId)) peerSyncState.set(peerId, {});
            const state = peerSyncState.get(peerId);
            const now = Date.now();
            const elapsed = now - (state.lastPhotoReceived || 0);

            // If photos arriving faster than expected backoff, strip them
            if (state.lastPhotoReceived && elapsed < (state.photoBackoff || 0) * 0.5) {
                netLog('block', `Stripped photos from peer (rate limit exceeded)`);
                data.photos = null;
            } else {
                data.photos = await cleanPhotos(data.photos);

                if (data.photos) {
                    // Enforce photo storage quota
                    const usage = await estimatePhotoStorage();
                    if (usage > MAX_PHOTO_STORAGE_BYTES) {
                        const excess = usage - MAX_PHOTO_STORAGE_BYTES + (1024 * 1024);
                        await evictOldestPhotos(excess);
                    }

                    // Ratchet up backoff for next photo-bearing sighting
                    state.lastPhotoReceived = now;
                    state.photoBackoff = state.photoBackoff
                        ? Math.min(state.photoBackoff * 2, PHOTO_BACKOFF_MAX_MS)
                        : PHOTO_BACKOFF_BASE_MS;
                }
            }
        }

        addSeen(data.id);
        const exists = await sightingExists(data.id);
        if (!exists) {
            data.received_at = new Date().toISOString();
            await saveSighting(data);
            netLog('sync', `Synced sighting "${data.title || data.id}" (${data.report_type})${data.photos ? ` +${data.photos.length} photo(s)` : ''}`);
            if (onSightingReceived) onSightingReceived(data);
        }
    });

    // --- Confirmation sync handlers ---

    getSyncConfIds(async (theirIds, peerId) => {
        if (!Array.isArray(theirIds)) return;

        const state = peerSyncState.get(peerId);
        if (state && state.lastConfSyncSent && Date.now() - state.lastConfSyncSent < SYNC_COOLDOWN_MS) return;

        const ourIds = await getAllConfirmationIds();
        const theirIdSet = new Set(theirIds.slice(0, MAX_SYNC_CONF_IDS));
        const theyNeed = ourIds.filter(id => !theirIdSet.has(id)).slice(0, MAX_SYNC_CONFIRMATIONS);

        if (theyNeed.length === 0) return;

        if (!peerSyncState.has(peerId)) peerSyncState.set(peerId, {});
        peerSyncState.get(peerId).lastConfSyncSent = Date.now();

        const confirmations = await getConfirmationsById(theyNeed);
        netLog('sync', `Sending ${confirmations.length} missing confirmations to peer`);
        for (const c of confirmations) {
            sendSyncConfData(c, peerId);
        }
    });

    getSyncConfData(async (data, peerId) => {
        if (!data || !data.id || !data.sighting_id || typeof data.confirmed !== 'boolean') return;
        if (seenMessages.has(data.id)) return;
        addSeen(data.id);

        await saveConfirmation({
            id: data.id,
            sighting_id: data.sighting_id,
            confirmed: data.confirmed,
            created_at: data.created_at || new Date().toISOString()
        });

        if (onSightingReceived) onSightingReceived(null);
    });

    // --- Peer lifecycle ---

    room.onPeerJoin(async (peerId) => {
        peerCount++;
        if (onPeerCountChange) onPeerCountChange(peerCount);
        netLog('peer', `Peer joined (${peerCount} total)`);

        // Initiate sync: send our sighting IDs and confirmation IDs
        const ids = await getAllSightingIds();
        sendSyncIds(ids.slice(0, MAX_SYNC_IDS), peerId);

        const confIds = await getAllConfirmationIds();
        sendSyncConfIds(confIds.slice(0, MAX_SYNC_CONF_IDS), peerId);
    });

    room.onPeerLeave((peerId) => {
        peerCount = Math.max(0, peerCount - 1);
        peerSyncState.delete(peerId);
        if (onPeerCountChange) onPeerCountChange(peerCount);
        netLog('peer', `Peer left (${peerCount} total)`);
    });

    networkStartTime = Date.now();
    netLog('info', 'Network initialized — connecting to Nostr relays');
}

/**
 * Send missing sightings to a peer.
 * Text-only sightings send immediately.
 * Photo-bearing sightings send with exponential backoff (2s, 4s, 8s, ..., 60s max).
 */
async function sendMissingSightings(ids, peerId) {
    const sightings = await getSightingsById(ids);
    let photoDelay = 0;

    for (const s of sightings) {
        const hasPhotos = s.photos && s.photos.length > 0;

        if (hasPhotos) {
            if (photoDelay > 0) await sleep(photoDelay);

            const toSend = { ...s, photos: s.photos.slice(0, MAX_PHOTOS_PER_SIGHTING) };
            sendSyncData(toSend, peerId);

            photoDelay = photoDelay === 0
                ? PHOTO_BACKOFF_BASE_MS
                : Math.min(photoDelay * 2, PHOTO_BACKOFF_MAX_MS);
        } else {
            sendSyncData(s, peerId);
        }
    }
}

/**
 * Broadcast a sighting report after a random delay (2-30 seconds).
 * The delay prevents timing correlation.
 * @param {object} sighting - Sighting data (no identifying fields)
 */
export function publishSighting(sighting) {
    addSeen(sighting.id);

    // Random delay: 2-30 seconds to prevent timing analysis
    const delay = 2000 + Math.random() * 28000;

    setTimeout(() => {
        if (sendSighting && peerCount > 0) {
            sendSighting(sighting);
            sightingsSent++;
            netLog('send', `Broadcast sighting after ${Math.round(delay / 1000)}s delay`);
        }
    }, delay);
}

/**
 * Broadcast a confirmation/dispute.
 * @param {string} sightingId
 * @param {boolean} confirmed
 */
export function publishConfirmation(sightingId, confirmed) {
    const data = {
        sighting_id: sightingId,
        confirmed,
        timestamp: Date.now()
    };

    // Small random delay for confirmations too
    const delay = 1000 + Math.random() * 5000;

    setTimeout(() => {
        if (sendConfirmation && peerCount > 0) {
            sendConfirmation(data);
        }
    }, delay);
}

export function getPeerCount() {
    return peerCount;
}

export function getBlockedCount() {
    return blockedCount;
}

export function getNetworkStats() {
    const uptimeMs = networkStartTime ? Date.now() - networkStartTime : 0;
    const uptimeMins = Math.floor(uptimeMs / 60000);
    const uptimeHours = Math.floor(uptimeMins / 60);
    let uptime;
    if (uptimeHours > 0) uptime = `${uptimeHours}h ${uptimeMins % 60}m`;
    else if (uptimeMins > 0) uptime = `${uptimeMins}m`;
    else uptime = `${Math.floor(uptimeMs / 1000)}s`;

    let trackerInfo = '';
    try {
        const sockets = getRelaySockets();
        const states = Object.entries(sockets).map(([url, s]) =>
            `${new URL(url).hostname}:${['CONN','OPEN','CLOS','DEAD'][s.readyState]}`
        );
        trackerInfo = states.join(', ');
    } catch {}

    return {
        peers: peerCount,
        blocked: blockedCount,
        sightingsReceived,
        sightingsSent,
        syncsCompleted: syncCompletedCount,
        seenMessages: seenMessages.size,
        uptime,
        protocol: 'Nostr + WebRTC',
        room: ROOM_NAME,
        selfId: selfId?.slice(0, 8) + '...',
        trackers: trackerInfo,
    };
}

export function onConsoleLog(callback) {
    consoleCallback = callback;
    // Flush buffered early logs
    if (callback && earlyLogs.length > 0) {
        for (const entry of earlyLogs) {
            callback(entry.tag, entry.msg);
        }
        earlyLogs.length = 0;
    }
}

export function shutdown() {
    if (room) {
        room.leave();
        room = null;
    }
    peerSyncState.clear();
}
