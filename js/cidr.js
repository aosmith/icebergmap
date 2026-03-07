// Federal government CIDR blacklist
// Sourced from live ARIN WHOIS REST API queries (March 2026) and BGP announcements
//
// Used to check WebRTC ICE candidates against known federal IP ranges.
// Best-effort in a browser context — they can always use VPNs.

const FEDERAL_CIDRS = [
    // DHS (Department of Homeland Security) — ARIN org DHS-37, DHS-37-Z, DHS-39
    { cidr: '64.69.48.0/20', org: 'DHS' },
    { cidr: '173.255.48.0/20', org: 'DHS' },
    { cidr: '216.81.80.0/20', org: 'DHS' },
    { cidr: '161.214.0.0/16', org: 'DHS' },
    { cidr: '208.73.184.0/21', org: 'DHS/CISA' },
    { cidr: '63.64.152.0/22', org: 'DHS' },

    // DOJ (Department of Justice) — AS15130
    { cidr: '149.101.0.0/16', org: 'DOJ' },
    { cidr: '192.58.200.0/22', org: 'DOJ' },

    // FBI — ARIN orgs FBI-40, FBI-52
    { cidr: '97.107.198.32/28', org: 'FBI' },

    // DoD (Department of Defense) — AS721
    { cidr: '6.0.0.0/8', org: 'DoD/Army' },
    { cidr: '7.0.0.0/8', org: 'DoD/DISA' },
    { cidr: '11.0.0.0/8', org: 'DoD/Intel' },
    { cidr: '21.0.0.0/8', org: 'DoD/DISA' },
    { cidr: '22.0.0.0/8', org: 'DoD/DISA' },
    { cidr: '26.0.0.0/8', org: 'DoD/DISA' },
    { cidr: '29.0.0.0/8', org: 'DoD/DISA' },
    { cidr: '30.0.0.0/8', org: 'DoD/DISA' },
    { cidr: '33.0.0.0/8', org: 'DoD/DLA' },
    { cidr: '55.0.0.0/8', org: 'DoD/ANG' },
    { cidr: '214.0.0.0/8', org: 'DoD' },
    { cidr: '215.0.0.0/8', org: 'DoD' },
    { cidr: '128.50.0.0/16', org: 'DoD' },
    { cidr: '128.51.0.0/16', org: 'DoD' },
];

// Parse CIDR into { network: number, mask: number }
function parseCidr(cidr) {
    const [ip, prefix] = cidr.split('/');
    const parts = ip.split('.').map(Number);
    const network = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
    const mask = prefix == 0 ? 0 : (~0 << (32 - parseInt(prefix))) >>> 0;
    return { network: (network & mask) >>> 0, mask };
}

function ipToInt(ip) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return null;
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

// Pre-parse all CIDRs for fast matching
const PARSED_CIDRS = FEDERAL_CIDRS.map(entry => ({
    ...parseCidr(entry.cidr),
    org: entry.org,
    cidr: entry.cidr
}));

/**
 * Check if an IP address belongs to a known federal government network.
 * @param {string} ip - IPv4 address string
 * @returns {{ blocked: boolean, org?: string, cidr?: string }}
 */
export function checkFederalIP(ip) {
    const addr = ipToInt(ip);
    if (addr === null) return { blocked: false };

    for (const entry of PARSED_CIDRS) {
        if ((addr & entry.mask) >>> 0 === entry.network) {
            return { blocked: true, org: entry.org, cidr: entry.cidr };
        }
    }
    return { blocked: false };
}

/**
 * Extract IP addresses from a WebRTC ICE candidate string.
 * @param {string} candidate - ICE candidate string
 * @returns {string[]} Array of IP addresses found
 */
export function extractIPsFromCandidate(candidate) {
    // ICE candidate format: "candidate:... <ip> <port> ..."
    // Match IPv4 addresses
    const ipv4Regex = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g;
    const matches = candidate.match(ipv4Regex) || [];
    // Filter out mDNS candidates (*.local) and private ranges
    return matches.filter(ip => {
        const parts = ip.split('.').map(Number);
        // Skip private/link-local ranges — we only care about public IPs
        if (parts[0] === 10) return false;
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
        if (parts[0] === 192 && parts[1] === 168) return false;
        if (parts[0] === 127) return false;
        if (parts[0] === 169 && parts[1] === 254) return false;
        return true;
    });
}

export { FEDERAL_CIDRS };
