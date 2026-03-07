import { describeAsync, testAsync, expect } from './runner.js';
import { openDB, saveSighting, getSightings, sightingExists, saveConfirmation, getConfirmationCounts, getSightingCount, clearAllData } from '../js/db.js';

function makeSighting(overrides = {}) {
    const id = crypto.randomUUID();
    return {
        id,
        title: 'Test sighting',
        report_type: 'checkpoint',
        description: 'Agents spotted at intersection',
        latitude: 34.05,
        longitude: -118.25,
        location_name: 'Downtown LA',
        state: 'CA',
        agent_count: 3,
        vehicle_description: 'White SUV',
        sighted_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        received_at: new Date().toISOString(),
        ...overrides
    };
}

export async function runDbTests() {

    // Clean slate
    await openDB();
    await clearAllData();

    await describeAsync('Database — save and retrieve', async () => {
        await testAsync('saves a sighting', async () => {
            const s = makeSighting();
            await saveSighting(s);
            const exists = await sightingExists(s.id);
            expect(exists).toBeTruthy();
        });

        await testAsync('retrieves sightings in reverse chronological order', async () => {
            await clearAllData();
            const s1 = makeSighting({ received_at: '2026-01-01T00:00:00Z', title: 'First' });
            const s2 = makeSighting({ received_at: '2026-03-01T00:00:00Z', title: 'Second' });
            await saveSighting(s1);
            await saveSighting(s2);
            const results = await getSightings({ limit: 10 });
            expect(results.length).toBe(2);
            expect(results[0].id).toBe(s2.id); // newer first
        });

        await testAsync('deduplicates by ID (put is idempotent)', async () => {
            await clearAllData();
            const s = makeSighting();
            await saveSighting(s);
            await saveSighting(s); // save again
            const count = await getSightingCount();
            expect(count).toBe(1);
        });

        await testAsync('filters by report type', async () => {
            await clearAllData();
            await saveSighting(makeSighting({ report_type: 'raid' }));
            await saveSighting(makeSighting({ report_type: 'patrol' }));
            await saveSighting(makeSighting({ report_type: 'raid' }));
            const raids = await getSightings({ type: 'raid' });
            expect(raids.length).toBe(2);
            const patrols = await getSightings({ type: 'patrol' });
            expect(patrols.length).toBe(1);
        });

        await testAsync('filters by state', async () => {
            await clearAllData();
            await saveSighting(makeSighting({ state: 'TX' }));
            await saveSighting(makeSighting({ state: 'CA' }));
            await saveSighting(makeSighting({ state: 'TX' }));
            const tx = await getSightings({ state: 'TX' });
            expect(tx.length).toBe(2);
        });

        await testAsync('returns correct count', async () => {
            await clearAllData();
            await saveSighting(makeSighting());
            await saveSighting(makeSighting());
            await saveSighting(makeSighting());
            const count = await getSightingCount();
            expect(count).toBe(3);
        });
    });

    await describeAsync('Database — confirmations', async () => {
        await testAsync('saves and counts confirmations', async () => {
            await clearAllData();
            const s = makeSighting();
            await saveSighting(s);

            await saveConfirmation({ id: 'c1', sighting_id: s.id, confirmed: true, created_at: new Date().toISOString() });
            await saveConfirmation({ id: 'c2', sighting_id: s.id, confirmed: true, created_at: new Date().toISOString() });
            await saveConfirmation({ id: 'c3', sighting_id: s.id, confirmed: false, created_at: new Date().toISOString() });

            const counts = await getConfirmationCounts(s.id);
            expect(counts.confirms).toBe(2);
            expect(counts.disputes).toBe(1);
        });

        await testAsync('returns zero counts for no confirmations', async () => {
            const counts = await getConfirmationCounts('nonexistent-id');
            expect(counts.confirms).toBe(0);
            expect(counts.disputes).toBe(0);
        });
    });

    await describeAsync('Database — clearAllData', async () => {
        await testAsync('clears everything', async () => {
            await saveSighting(makeSighting());
            await saveSighting(makeSighting());
            await clearAllData();
            const count = await getSightingCount();
            expect(count).toBe(0);
        });
    });
}
