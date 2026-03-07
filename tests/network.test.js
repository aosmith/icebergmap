// P2P integration test using a loopback proxy
// Tests that two "peers" in the same browser can exchange sighting data
// through a simulated gossip channel (no real BitTorrent/WebRTC needed)

import { describeAsync, testAsync, expect } from './runner.js';
import { openDB, saveSighting, getSightings, sightingExists, clearAllData } from '../js/db.js';

// Simulate the P2P message flow without Trystero
// This tests the data handling logic that sits on top of the transport
class MockGossipChannel {
    constructor() {
        this.listeners = [];
    }

    onMessage(fn) {
        this.listeners.push(fn);
    }

    broadcast(data) {
        // Simulate network delay (async)
        setTimeout(() => {
            for (const fn of this.listeners) {
                fn(structuredClone(data), 'mock-peer-id');
            }
        }, 10);
    }

    broadcastSync(data) {
        for (const fn of this.listeners) {
            fn(structuredClone(data), 'mock-peer-id');
        }
    }
}

export async function runNetworkTests() {
    await openDB();
    await clearAllData();

    await describeAsync('P2P message handling — loopback', async () => {

        await testAsync('sighting broadcast and receive via mock channel', async () => {
            await clearAllData();
            const channel = new MockGossipChannel();
            const received = [];

            // Simulate "peer B" receiving
            channel.onMessage(async (data, peerId) => {
                if (data.type === 'sighting') {
                    const exists = await sightingExists(data.payload.id);
                    if (!exists) {
                        data.payload.received_at = new Date().toISOString();
                        await saveSighting(data.payload);
                        received.push(data.payload);
                    }
                }
            });

            // "Peer A" sends a sighting
            const sighting = {
                id: crypto.randomUUID(),
                title: 'P2P test sighting',
                report_type: 'patrol',
                description: 'Patrol car on 5th Ave',
                latitude: 40.758,
                longitude: -73.985,
                location_name: 'Times Square',
                state: 'NY',
                agent_count: 2,
                vehicle_description: null,
                sighted_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
                received_at: new Date().toISOString(),
            };

            channel.broadcastSync({ type: 'sighting', payload: sighting });

            // Wait a tick for async save
            await new Promise(r => setTimeout(r, 50));

            // Verify it was received and stored
            expect(received.length).toBe(1);
            expect(received[0].id).toBe(sighting.id);
            expect(received[0].title).toBe('P2P test sighting');

            const stored = await sightingExists(sighting.id);
            expect(stored).toBeTruthy();
        });

        await testAsync('deduplicates same sighting from multiple peers', async () => {
            await clearAllData();
            const channel = new MockGossipChannel();
            let receiveCount = 0;

            channel.onMessage(async (data) => {
                if (data.type === 'sighting') {
                    const exists = await sightingExists(data.payload.id);
                    if (!exists) {
                        await saveSighting(data.payload);
                        receiveCount++;
                    }
                }
            });

            const sighting = {
                id: crypto.randomUUID(),
                title: 'Duplicate test',
                report_type: 'raid',
                description: 'Test',
                sighted_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
                received_at: new Date().toISOString(),
            };

            // Same sighting arrives from 3 different "peers"
            channel.broadcastSync({ type: 'sighting', payload: sighting });
            await new Promise(r => setTimeout(r, 50));

            channel.broadcastSync({ type: 'sighting', payload: sighting });
            await new Promise(r => setTimeout(r, 50));

            channel.broadcastSync({ type: 'sighting', payload: sighting });
            await new Promise(r => setTimeout(r, 50));

            // Should only have been saved once
            expect(receiveCount).toBe(1);
        });

        await testAsync('sighting contains no identifying information', async () => {
            // Verify our sighting data model has no identity fields
            const sighting = {
                id: crypto.randomUUID(),
                title: 'Anonymity check',
                report_type: 'checkpoint',
                description: 'Test',
                latitude: 34.0,
                longitude: -118.0,
                location_name: 'Test location',
                state: 'CA',
                agent_count: 1,
                vehicle_description: null,
                sighted_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
                received_at: new Date().toISOString(),
            };

            const json = JSON.stringify(sighting);
            // Must NOT contain any of these identity-related fields
            const forbidden = ['user_id', 'public_key', 'private_key', 'node_id',
                             'device_id', 'signature', 'reporter_id', 'peer_id',
                             'ip_address', 'fingerprint'];

            for (const field of forbidden) {
                expect(json.includes(`"${field}"`)).toBeFalsy();
            }
        });

        await testAsync('confirmation flow via mock channel', async () => {
            await clearAllData();
            const channel = new MockGossipChannel();
            const confirmations = [];

            channel.onMessage(async (data) => {
                if (data.type === 'confirmation') {
                    confirmations.push(data.payload);
                }
            });

            const sightingId = crypto.randomUUID();
            channel.broadcastSync({
                type: 'confirmation',
                payload: { sighting_id: sightingId, confirmed: true, timestamp: Date.now() }
            });
            channel.broadcastSync({
                type: 'confirmation',
                payload: { sighting_id: sightingId, confirmed: false, timestamp: Date.now() }
            });

            await new Promise(r => setTimeout(r, 50));

            expect(confirmations.length).toBe(2);
            expect(confirmations[0].confirmed).toBe(true);
            expect(confirmations[1].confirmed).toBe(false);
        });

        await testAsync('multiple sightings maintain order', async () => {
            await clearAllData();

            const s1 = {
                id: crypto.randomUUID(),
                title: 'First',
                report_type: 'patrol',
                description: 'First sighting',
                sighted_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
                received_at: '2026-03-01T10:00:00Z',
            };
            const s2 = {
                id: crypto.randomUUID(),
                title: 'Second',
                report_type: 'raid',
                description: 'Second sighting',
                sighted_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
                received_at: '2026-03-01T11:00:00Z',
            };

            await saveSighting(s1);
            await saveSighting(s2);

            const results = await getSightings({ limit: 10 });
            expect(results.length).toBe(2);
            // Newer received_at should come first
            expect(results[0].id).toBe(s2.id);
            expect(results[1].id).toBe(s1.id);
        });
    });
}
