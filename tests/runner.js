// Minimal test runner for browser-based tests

let passed = 0;
let failed = 0;
let currentSuite = '';
const results = [];

export function describe(name, fn) {
    currentSuite = name;
    log(`\n--- ${name} ---`, 'suite');
    fn();
}

export async function describeAsync(name, fn) {
    currentSuite = name;
    log(`\n--- ${name} ---`, 'suite');
    await fn();
}

export function test(name, fn) {
    try {
        fn();
        passed++;
        log(`  PASS  ${name}`, 'pass');
        results.push({ suite: currentSuite, name, status: 'pass' });
    } catch (e) {
        failed++;
        log(`  FAIL  ${name}: ${e.message}`, 'fail');
        results.push({ suite: currentSuite, name, status: 'fail', error: e.message });
    }
}

export async function testAsync(name, fn) {
    try {
        await fn();
        passed++;
        log(`  PASS  ${name}`, 'pass');
        results.push({ suite: currentSuite, name, status: 'pass' });
    } catch (e) {
        failed++;
        log(`  FAIL  ${name}: ${e.message}`, 'fail');
        results.push({ suite: currentSuite, name, status: 'fail', error: e.message });
    }
}

export function expect(actual) {
    return {
        toBe(expected) {
            if (actual !== expected) {
                throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
            }
        },
        toEqual(expected) {
            if (JSON.stringify(actual) !== JSON.stringify(expected)) {
                throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
            }
        },
        toBeTruthy() {
            if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`);
        },
        toBeFalsy() {
            if (actual) throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`);
        },
        toBeNull() {
            if (actual !== null) throw new Error(`Expected null, got ${JSON.stringify(actual)}`);
        },
        toBeGreaterThan(expected) {
            if (actual <= expected) throw new Error(`Expected ${actual} > ${expected}`);
        },
        toContain(expected) {
            if (Array.isArray(actual)) {
                if (!actual.includes(expected)) throw new Error(`Array does not contain ${JSON.stringify(expected)}`);
            } else if (typeof actual === 'string') {
                if (!actual.includes(expected)) throw new Error(`String does not contain ${JSON.stringify(expected)}`);
            }
        },
    };
}

export function summary() {
    const total = passed + failed;
    log(`\n========================================`, 'suite');
    log(`  ${total} tests: ${passed} passed, ${failed} failed`, failed > 0 ? 'fail' : 'pass');
    log(`========================================`, 'suite');
    return { passed, failed, total, results };
}

function log(msg, type) {
    const el = document.getElementById('test-output');
    if (el) {
        const line = document.createElement('div');
        line.className = `test-${type}`;
        line.textContent = msg;
        el.appendChild(line);
    }
    console.log(msg);
}
