// ─── Shared geo / map utilities ──────────────────────────────────────────────
import { getFilteredConnections } from './connections-panel.js';

let worldGeo = null;
let homeCountry = 'JP'; // configurable via settings

const COUNTRY_COORDS = {
  JP:{ lat:35.68, lon:139.69 }, US:{ lat:38.89, lon:-77.04 }, CA:{ lat:45.42, lon:-75.69 },
  GB:{ lat:51.50, lon:-0.12  }, DE:{ lat:52.52, lon:13.40  }, FR:{ lat:48.86, lon:2.35   },
  IT:{ lat:41.90, lon:12.50  }, ES:{ lat:40.42, lon:-3.70  }, NL:{ lat:52.09, lon:5.10   },
  SE:{ lat:59.33, lon:18.07  }, CH:{ lat:46.95, lon:7.45   }, NO:{ lat:59.91, lon:10.75  },
  AU:{ lat:-35.28,lon:149.13 }, NZ:{ lat:-41.29,lon:174.78 }, CN:{ lat:39.91, lon:116.39 },
  KR:{ lat:37.57, lon:126.98 }, TW:{ lat:25.04, lon:121.56 }, HK:{ lat:22.32, lon:114.17 },
  SG:{ lat:1.35,  lon:103.82 }, IN:{ lat:28.61, lon:77.21  }, BR:{ lat:-15.79,lon:-47.88 },
  RU:{ lat:55.75, lon:37.62  },
};

function getHomeCoord() {
  return COUNTRY_COORDS[homeCountry] || COUNTRY_COORDS['JP'];
}

// Returns D3 rotation [λ, 0] so longitude -λ is at the map centre.
function getMapRotation() {
  const R = {
    JP:[-140,0], KR:[-140,0], TW:[-140,0], HK:[-120,0], SG:[-115,0],
    AU:[-150,0], NZ:[-170,0],
    CN:[-110,0],
    IN:[-80,0],
    RU:[-60,0],
    GB:[-10,0], DE:[-10,0], FR:[-10,0], IT:[-10,0], ES:[-10,0],
    NL:[-10,0], SE:[-10,0], CH:[-10,0], NO:[-10,0],
    US:[95,0], CA:[95,0],
    BR:[55,0],
  };
  return R[homeCountry] || [-10, 0];
}

function buildMapPoints() {
  const orgMap = new Map();
  for (const c of getFilteredConnections()) {
    if (c.lat == null || c.lon == null) continue;
    const key = c.org || c.dst;
    if (!orgMap.has(key)) orgMap.set(key, {
      key, org: c.org || c.dstHost || c.dst,
      lat: c.lat, lon: c.lon, city: c.city || '', country: c.country || '',
      srcs: new Map(), maxTtl: 0, threat: false,
    });
    const e = orgMap.get(key);
    e.srcs.set(c.src, (e.srcs.get(c.src) || 0) + 1);
    if (c.threat) e.threat = true;
    if ((c.ttl || 0) > e.maxTtl) {
      e.maxTtl = c.ttl || 0;
      e.lat = c.lat; e.lon = c.lon;
      e.city = c.city || e.city;
      e.country = c.country || e.country;
    }
  }
  return [...orgMap.values()].map(e => ({
    ...e,
    threat: e.threat,
    totalSessions: [...e.srcs.values()].reduce((a, b) => a + b, 0),
    freshness: Math.max(0.15, Math.min(1.0, (e.maxTtl || 0) / 300)),
  }));
}

function ensureWorldGeo(cb) {
  if (worldGeo) { cb(); return; }
  d3.json('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json')
    .then(topo => { worldGeo = topojson.feature(topo, topo.objects.countries); cb(); })
    .catch(err => console.error('[geo] load failed', err));
}

export { worldGeo, homeCountry, getHomeCoord, getMapRotation, buildMapPoints, ensureWorldGeo, COUNTRY_COORDS };
export function setWorldGeo(v) { worldGeo = v; }
export function setHomeCountry(v) { homeCountry = v; }
