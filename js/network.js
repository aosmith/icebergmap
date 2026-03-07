// P2P networking via Trystero (BitTorrent DHT matchmaking + WebRTC)
// All messages are anonymous — no peer IDs, no identity, just sighting data

import { joinRoom } from 'https://esm.run/trystero/torrent';
import { saveSighting, sightingExists, saveConfirmation } from './db.js';
import { checkFederalIP, extractIPsFromCandidate } from './cidr.js';

const APP_ID = 'icebergmap-anonymous-sightings-v1';
const ROOM_NAME = 'sightings';

let room = null;
let sendSighting = null;
let sendConfirmation = null;
let peerCount = 0;
let blockedCount = 0;
let onPeerCountChange = null;
let onSightingReceived = null;

// Track seen message IDs to prevent infinite re-broadcast
const seenMessages = new Set();
const MAX_SEEN = 5000;

function addSeen(id) {
    seenMessages.add(id);
    // Evict oldest if too large
    if (seenMessages.size > MAX_SEEN) {
        const first = seenMessages.values().next().value;
        seenMessages.delete(first);
    }
}

/**
 * Initialize P2P network.
 * @param {{ onSighting: Function, onPeerCount: Function }} callbacks
 */
export function initNetwork({ onSighting, onPeerCount }) {
    onSightingReceived = onSighting;
    onPeerCountChange = onPeerCount;

    room = joinRoom({ appId: APP_ID }, ROOM_NAME);

    // Create actions for sending/receiving
    const [_sendSighting, getSighting] = room.makeAction('sighting');
    const [_sendConfirmation, getConfirmation] = room.makeAction('confirmation');

    sendSighting = _sendSighting;
    sendConfirmation = _sendConfirmation;

    // Handle incoming sightings
    getSighting(async (data, peerId) => {
        if (seenMessages.has(data.id)) return;
        addSeen(data.id);

        // Store locally
        const exists = await sightingExists(data.id);
        if (!exists) {
            data.received_at = new Date().toISOString();
            await saveSighting(data);
            if (onSightingReceived) onSightingReceived(data);
        }
    });

    // Handle incoming confirmations
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

        if (onSightingReceived) onSightingReceived(null); // Trigger refresh
    });

    room.onPeerJoin((peerId) => {
        peerCount++;
        if (onPeerCountChange) onPeerCountChange(peerCount);
        console.log(`[P2P] Peer joined (${peerCount} total)`);
    });

    room.onPeerLeave((peerId) => {
        peerCount = Math.max(0, peerCount - 1);
        if (onPeerCountChange) onPeerCountChange(peerCount);
        console.log(`[P2P] Peer left (${peerCount} total)`);
    });

    console.log('[P2P] Network initialized — joining BitTorrent DHT swarm');
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
}
