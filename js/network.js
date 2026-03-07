// P2P networking via Trystero (BitTorrent DHT matchmaking + WebRTC)
// All messages are anonymous — no peer IDs, no identity, just sighting data

import { joinRoom } from 'https://esm.run/trystero/torrent';
import { saveSighting, sightingExists, saveConfirmation, getAllSightingIds, getSightingsById, estimatePhotoStorage, evictOldestPhotos } from './db.js';
import { checkFederalIP, extractIPsFromCandidate } from './cidr.js';
import { reencodePhoto } from './media.js';

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
const SYNC_COOLDOWN_MS = 60000;

let room = null;
let sendSighting = null;
let sendConfirmation = null;
let sendSyncIds = null;
let sendSyncData = null;
let peerCount = 0;
let blockedCount = 0;
let onPeerCountChange = null;
let onSightingReceived = null;

// Track seen message IDs to prevent infinite re-broadcast
const seenMessages = new Set();
const MAX_SEEN = 5000;

// Per-peer sync state
const peerSyncState = new Map();

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

    room = joinRoom({ appId: APP_ID }, ROOM_NAME);

    // Live broadcast actions
    const [_sendSighting, getSighting] = room.makeAction('sighting');
    const [_sendConfirmation, getConfirmation] = room.makeAction('confirmation');

    // Sync actions
    const [_sendSyncIds, getSyncIds] = room.makeAction('sync-ids');
    const [_sendSyncData, getSyncData] = room.makeAction('sync-data');

    sendSighting = _sendSighting;
    sendConfirmation = _sendConfirmation;
    sendSyncIds = _sendSyncIds;
    sendSyncData = _sendSyncData;

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
            if (onSightingReceived) onSightingReceived(data);
        }
    });

    // --- Peer lifecycle ---

    room.onPeerJoin(async (peerId) => {
        peerCount++;
        if (onPeerCountChange) onPeerCountChange(peerCount);
        console.log(`[P2P] Peer joined (${peerCount} total)`);

        // Initiate sync: send our sighting IDs
        const ids = await getAllSightingIds();
        sendSyncIds(ids.slice(0, MAX_SYNC_IDS), peerId);
    });

    room.onPeerLeave((peerId) => {
        peerCount = Math.max(0, peerCount - 1);
        peerSyncState.delete(peerId);
        if (onPeerCountChange) onPeerCountChange(peerCount);
        console.log(`[P2P] Peer left (${peerCount} total)`);
    });

    console.log('[P2P] Network initialized — joining BitTorrent DHT swarm');
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
            console.log(`[P2P] Broadcast sighting after ${Math.round(delay / 1000)}s delay`);
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

export function shutdown() {
    if (room) {
        room.leave();
        room = null;
    }
    peerSyncState.clear();
}
