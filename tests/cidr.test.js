import { describe, test, expect } from './runner.js';
import { checkFederalIP, extractIPsFromCandidate, FEDERAL_CIDRS } from '../js/cidr.js';

export function runCidrTests() {

    describe('CIDR blacklist data', () => {
        test('has entries loaded', () => {
            expect(FEDERAL_CIDRS.length).toBeGreaterThan(10);
        });

        test('every entry has cidr and org', () => {
            for (const entry of FEDERAL_CIDRS) {
                expect(!!entry.cidr).toBeTruthy();
                expect(!!entry.org).toBeTruthy();
            }
        });
    });

    describe('checkFederalIP — DHS ranges', () => {
        test('blocks 64.69.48.1 (DHS ONENET)', () => {
            const result = checkFederalIP('64.69.48.1');
            expect(result.blocked).toBeTruthy();
            expect(result.org).toBe('DHS');
        });

        test('blocks 64.69.63.254 (DHS ONENET upper end)', () => {
            expect(checkFederalIP('64.69.63.254').blocked).toBeTruthy();
        });

        test('blocks 161.214.100.50 (DHS INSINC)', () => {
            const result = checkFederalIP('161.214.100.50');
            expect(result.blocked).toBeTruthy();
            expect(result.org).toBe('DHS');
        });

        test('blocks 173.255.55.1 (DHS)', () => {
            expect(checkFederalIP('173.255.55.1').blocked).toBeTruthy();
        });

        test('blocks 208.73.185.10 (DHS/CISA)', () => {
            const result = checkFederalIP('208.73.185.10');
            expect(result.blocked).toBeTruthy();
        });

        test('does NOT block 64.69.47.255 (just below DHS range)', () => {
            expect(checkFederalIP('64.69.47.255').blocked).toBeFalsy();
        });

        test('does NOT block 64.70.0.1 (above DHS range)', () => {
            expect(checkFederalIP('64.70.0.1').blocked).toBeFalsy();
        });
    });

    describe('checkFederalIP — DOJ ranges', () => {
        test('blocks 149.101.1.1 (DOJ)', () => {
            const result = checkFederalIP('149.101.1.1');
            expect(result.blocked).toBeTruthy();
            expect(result.org).toBe('DOJ');
        });

        test('blocks 149.101.255.255 (DOJ upper end)', () => {
            expect(checkFederalIP('149.101.255.255').blocked).toBeTruthy();
        });

        test('blocks 192.58.201.5 (DOJ BLS)', () => {
            expect(checkFederalIP('192.58.201.5').blocked).toBeTruthy();
        });

        test('does NOT block 149.102.0.1 (outside DOJ /16)', () => {
            expect(checkFederalIP('149.102.0.1').blocked).toBeFalsy();
        });
    });

    describe('checkFederalIP — FBI range', () => {
        test('blocks 97.107.198.33 (FBI)', () => {
            const result = checkFederalIP('97.107.198.33');
            expect(result.blocked).toBeTruthy();
            expect(result.org).toBe('FBI');
        });

        test('blocks 97.107.198.47 (FBI upper end of /28)', () => {
            expect(checkFederalIP('97.107.198.47').blocked).toBeTruthy();
        });

        test('does NOT block 97.107.198.48 (just above FBI /28)', () => {
            expect(checkFederalIP('97.107.198.48').blocked).toBeFalsy();
        });
    });

    describe('checkFederalIP — DoD /8 ranges', () => {
        test('blocks 6.1.2.3 (Army)', () => {
            const result = checkFederalIP('6.1.2.3');
            expect(result.blocked).toBeTruthy();
        });

        test('blocks 7.0.0.1 (DISA)', () => {
            expect(checkFederalIP('7.0.0.1').blocked).toBeTruthy();
        });

        test('blocks 11.255.255.255 (DoD Intel)', () => {
            expect(checkFederalIP('11.255.255.255').blocked).toBeTruthy();
        });

        test('blocks 22.100.50.25 (DISA)', () => {
            expect(checkFederalIP('22.100.50.25').blocked).toBeTruthy();
        });

        test('blocks 55.0.0.1 (Army National Guard)', () => {
            expect(checkFederalIP('55.0.0.1').blocked).toBeTruthy();
        });

        test('blocks 214.10.20.30 (DoD)', () => {
            expect(checkFederalIP('214.10.20.30').blocked).toBeTruthy();
        });

        test('blocks 215.128.0.1 (DoD)', () => {
            expect(checkFederalIP('215.128.0.1').blocked).toBeTruthy();
        });
    });

    describe('checkFederalIP — safe IPs', () => {
        test('allows 8.8.8.8 (Google DNS)', () => {
            expect(checkFederalIP('8.8.8.8').blocked).toBeFalsy();
        });

        test('allows 1.1.1.1 (Cloudflare)', () => {
            expect(checkFederalIP('1.1.1.1').blocked).toBeFalsy();
        });

        test('allows 142.250.80.46 (Google)', () => {
            expect(checkFederalIP('142.250.80.46').blocked).toBeFalsy();
        });

        test('allows 104.16.0.1 (Cloudflare)', () => {
            expect(checkFederalIP('104.16.0.1').blocked).toBeFalsy();
        });

        test('returns not blocked for invalid IP', () => {
            expect(checkFederalIP('not.an.ip').blocked).toBeFalsy();
        });

        test('returns not blocked for empty string', () => {
            expect(checkFederalIP('').blocked).toBeFalsy();
        });
    });

    describe('extractIPsFromCandidate', () => {
        test('extracts IP from ICE candidate', () => {
            const candidate = 'candidate:1 1 udp 2113937151 192.0.2.1 5000 typ host';
            const ips = extractIPsFromCandidate(candidate);
            expect(ips).toContain('192.0.2.1');
        });

        test('filters out private 10.x.x.x', () => {
            const candidate = 'candidate:1 1 udp 2113937151 10.0.0.5 5000 typ host';
            const ips = extractIPsFromCandidate(candidate);
            expect(ips.length).toBe(0);
        });

        test('filters out private 192.168.x.x', () => {
            const candidate = 'candidate:1 1 udp 2113937151 192.168.1.1 5000 typ host';
            const ips = extractIPsFromCandidate(candidate);
            expect(ips.length).toBe(0);
        });

        test('filters out private 172.16-31.x.x', () => {
            const candidate = 'candidate:1 1 udp 2113937151 172.16.0.1 5000 typ host';
            const ips = extractIPsFromCandidate(candidate);
            expect(ips.length).toBe(0);
        });

        test('filters out loopback', () => {
            const candidate = 'candidate:1 1 udp 2113937151 127.0.0.1 5000 typ host';
            const ips = extractIPsFromCandidate(candidate);
            expect(ips.length).toBe(0);
        });

        test('extracts multiple public IPs', () => {
            const candidate = 'candidate:1 1 udp 2113937151 203.0.113.1 5000 typ srflx raddr 198.51.100.2 rport 6000';
            const ips = extractIPsFromCandidate(candidate);
            expect(ips.length).toBe(2);
            expect(ips).toContain('203.0.113.1');
            expect(ips).toContain('198.51.100.2');
        });

        test('returns empty for no IPs', () => {
            const ips = extractIPsFromCandidate('candidate:1 1 udp typ host');
            expect(ips.length).toBe(0);
        });
    });
}
