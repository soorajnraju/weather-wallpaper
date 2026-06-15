/* ============================================================
   Sky Wallpaper – sky.js
   Real-time astronomical sky renderer driven by local weather.

   Architecture
   ─────────────
   1. ASTRO          – Julian date, GMST, coordinate transforms
   2. SUN            – Accurate sun position (good to ~0.01°)
   3. MOON           – Position + phase
   4. PLANETS        – Simplified VSOP for visible planets
   5. STAR CATALOG   – ~120 real named stars + procedural fill
   6. SKY RENDERER   – Canvas2D dome, gradient, atmosphere
   7. WEATHER FX     – Clouds, rain, snow, fog particles
   8. WEATHER FETCH  – Open-Meteo API (cloud_cover, weather_code…)
   9. UI OVERLAY     – Bottom bar, planet list
  10. MAIN LOOP      – RAF, pause/resume, location injection
   ============================================================ */

'use strict';

// ─────────────────────────────────────────────
// 1. ASTRO – core math
// ─────────────────────────────────────────────
var Astro = (function () {
    var D2R = Math.PI / 180;
    var R2D = 180 / Math.PI;

    function julianDate(date) {
        return date.getTime() / 86400000 + 2440587.5;
    }

    // Greenwich Mean Sidereal Time in degrees
    function gmst(jd) {
        var T = (jd - 2451545.0) / 36525;
        var t = 280.46061837 + 360.98564736629 * (jd - 2451545.0)
            + 0.000387933 * T * T - T * T * T / 38710000;
        return ((t % 360) + 360) % 360;
    }

    // Local Apparent Sidereal Time
    function last(jd, lonDeg) {
        return ((gmst(jd) + lonDeg) % 360 + 360) % 360;
    }

    // Convert RA/Dec → Altitude/Azimuth
    // ra, dec in degrees; lat, lon in degrees; returns {alt, az} in degrees
    function raDecToAltAz(ra, dec, lat, lon, jd) {
        var lst = last(jd, lon);
        var ha = ((lst - ra) % 360 + 360) % 360;          // hour angle in degrees
        var haR = ha * D2R, latR = lat * D2R, decR = dec * D2R;
        var sinAlt = Math.sin(latR) * Math.sin(decR)
            + Math.cos(latR) * Math.cos(decR) * Math.cos(haR);
        sinAlt = Math.max(-1, Math.min(1, sinAlt));
        var alt = Math.asin(sinAlt) * R2D;
        var cosAz = (Math.sin(decR) - Math.sin(latR) * sinAlt)
            / (Math.cos(latR) * Math.cos(alt * D2R));
        cosAz = Math.max(-1, Math.min(1, cosAz));
        var az = Math.acos(cosAz) * R2D;
        if (Math.sin(haR) > 0) az = 360 - az;
        return { alt: alt, az: az };
    }

    // Modulo that always returns positive
    function mod(x, m) { return ((x % m) + m) % m; }

    // Solve Kepler's equation iteratively
    function kepler(M, e) {
        var E = M;
        for (var i = 0; i < 8; i++) {
            E = M + e * Math.sin(E);
        }
        return E;
    }

    return {
        julianDate: julianDate, gmst: gmst, last: last,
        raDecToAltAz: raDecToAltAz, mod: mod, kepler: kepler,
        D2R: D2R, R2D: R2D
    };
})();

// ─────────────────────────────────────────────
// 2. SUN – position (accurate to ~0.01°)
// ─────────────────────────────────────────────
var Sun = (function () {
    var D2R = Astro.D2R, R2D = Astro.R2D;

    // Returns {ra, dec, alt, az, dist} – ra/dec in degrees
    function position(jd, lat, lon) {
        var n = jd - 2451545.0;
        // Mean longitude & mean anomaly (degrees)
        var L = Astro.mod(280.460 + 0.9856474 * n, 360);
        var g = Astro.mod(357.528 + 0.9856003 * n, 360) * D2R;
        // Ecliptic longitude
        var lam = L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g);
        var eps = 23.439 - 0.0000004 * n;                // obliquity
        var lamR = lam * D2R, epsR = eps * D2R;
        // RA / Dec
        var sinRA = Math.cos(epsR) * Math.sin(lamR);
        var cosRA = Math.cos(lamR);
        var ra = Astro.mod(Math.atan2(sinRA, cosRA) * R2D, 360);
        var dec = Math.asin(Math.sin(epsR) * Math.sin(lamR)) * R2D;
        var pos = Astro.raDecToAltAz(ra, dec, lat, lon, jd);
        return { ra: ra, dec: dec, alt: pos.alt, az: pos.az };
    }

    return { position: position };
})();

// ─────────────────────────────────────────────
// 3. MOON – position + phase
// ─────────────────────────────────────────────
var Moon = (function () {
    var D2R = Astro.D2R, R2D = Astro.R2D;

    function position(jd, lat, lon) {
        var T = (jd - 2451545.0) / 36525;
        // Mean elements
        var Lm = Astro.mod(218.3165 + 481267.8813 * T, 360);
        var D = Astro.mod(297.8502 + 445267.1115 * T, 360);
        var M = Astro.mod(357.5291 + 35999.0503 * T, 360);
        var Mm = Astro.mod(134.9634 + 477198.8676 * T, 360);
        var F = Astro.mod(93.2721 + 483202.0175 * T, 360);
        var DR = D * D2R, MR = M * D2R, MmR = Mm * D2R, FR = F * D2R;
        // Longitude corrections (major terms)
        var dLon = 6.289 * Math.sin(MmR)
            + 1.274 * Math.sin(2 * DR - MmR)
            + 0.658 * Math.sin(2 * DR)
            - 0.186 * Math.sin(MR)
            - 0.059 * Math.sin(2 * DR - 2 * MmR)
            - 0.057 * Math.sin(2 * DR - MR - MmR)
            + 0.053 * Math.sin(2 * DR + MmR)
            + 0.046 * Math.sin(2 * DR - MR)
            + 0.041 * Math.sin(MmR - MR);
        var lam = Lm + dLon;
        // Latitude
        var dLat = 5.128 * Math.sin(FR)
            + 0.280 * Math.sin(MmR + FR)
            + 0.277 * Math.sin(MmR - FR)
            + 0.173 * Math.sin(2 * DR - FR)
            + 0.055 * Math.sin(2 * DR - MmR + FR)
            + 0.046 * Math.sin(2 * DR - MmR - FR);
        var beta = dLat;                            // ecliptic latitude (deg)
        var lamR = lam * D2R, betR = beta * D2R;
        var eps = 23.439 - 0.0000004 * (jd - 2451545.0);
        var epsR = eps * D2R;
        // Equatorial
        var ra = Astro.mod(Math.atan2(Math.sin(lamR) * Math.cos(epsR) - Math.tan(betR) * Math.sin(epsR), Math.cos(lamR)) * R2D, 360);
        var dec = Math.asin(Math.sin(betR) * Math.cos(epsR) + Math.cos(betR) * Math.sin(epsR) * Math.sin(lamR)) * R2D;
        var pos = Astro.raDecToAltAz(ra, dec, lat, lon, jd);
        // Phase angle (0=new, 0.5=full, 1=new again)
        var phaseAngle = Astro.mod(lam - (Sun.position(jd, lat, lon).ra), 360);
        var phase = phaseAngle / 360;
        // Illuminated fraction k
        var k = (1 - Math.cos(phaseAngle * D2R)) / 2;
        return { ra: ra, dec: dec, alt: pos.alt, az: pos.az, phase: phase, illuminated: k };
    }

    return { position: position };
})();

// ─────────────────────────────────────────────
// 4. PLANETS – simplified VSOP (good to ~1°)
// ─────────────────────────────────────────────
var Planets = (function () {
    var D2R = Astro.D2R, R2D = Astro.R2D;

    // Orbital elements at J2000.0 (epoch JD 2451545.0)
    // [a_AU, e, i_deg, Omega_deg, omega_deg, L0_deg, dL_deg_per_day]
    var ELEMENTS = {
        Mercury: [0.387098, 0.205636, 7.005, 48.331, 77.456, 252.251, 4.092317],
        Venus: [0.723332, 0.006772, 3.395, 76.680, 131.564, 181.980, 1.602136],
        Mars: [1.523688, 0.093396, 1.850, 49.558, 336.060, 355.433, 0.524039],
        Jupiter: [5.202561, 0.048472, 1.299, 100.464, 14.331, 34.351, 0.083056],
        Saturn: [9.537070, 0.053882, 2.494, 113.665, 93.057, 50.077, 0.033459],
        Uranus: [19.18917, 0.047072, 0.773, 74.006, 173.005, 314.055, 0.011730],
        Neptune: [30.06993, 0.008586, 1.770, 131.784, 48.124, 304.349, 0.005980],
    };

    // Visual magnitude at opposition (approx)
    var OPPOSITION_MAG = {
        Mercury: 0.0, Venus: -4.6, Mars: -2.9,
        Jupiter: -2.9, Saturn: 0.7, Uranus: 5.7, Neptune: 7.8
    };

    // Rough color for rendering
    var PLANET_COLOR = {
        Mercury: '#aaaaaa', Venus: '#fffde0',
        Mars: '#e8704a', Jupiter: '#d4b483',
        Saturn: '#e8d5a0', Uranus: '#a8dde0', Neptune: '#6070e0'
    };

    function heliocentric(name, jd) {
        var el = ELEMENTS[name];
        if (!el) return null;
        var a = el[0], e = el[1], i = el[2] * D2R;
        var Om = el[3] * D2R, om = el[4] * D2R;
        var n = jd - 2451545.0;
        var L = Astro.mod(el[5] + el[6] * n, 360) * D2R;
        var M = Astro.mod(L - om, 2 * Math.PI);
        var E = Astro.kepler(M, e);
        // True anomaly
        var nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2),
            Math.sqrt(1 - e) * Math.cos(E / 2));
        var r = a * (1 - e * Math.cos(E));
        // Heliocentric ecliptic coords
        var u = nu + om - Om;
        var x = r * (Math.cos(Om) * Math.cos(u) - Math.sin(Om) * Math.sin(u) * Math.cos(i));
        var y = r * (Math.sin(Om) * Math.cos(u) + Math.cos(Om) * Math.sin(u) * Math.cos(i));
        var z = r * Math.sin(u) * Math.sin(i);
        return { x: x, y: y, z: z, r: r };
    }

    function positionAll(jd, lat, lon) {
        var earth = heliocentric('Mars', jd); // placeholder — compute Earth below
        // Earth heliocentric
        var n = jd - 2451545.0;
        var Le = Astro.mod(100.465 + 0.985647 * n, 360) * D2R;
        var Me = Astro.mod(357.529 + 0.985608 * n, 360) * D2R;
        var Ee = Astro.kepler(Me, 0.016709);
        var nue = 2 * Math.atan2(Math.sqrt(1.016709) * Math.sin(Ee / 2),
            Math.sqrt(0.983291) * Math.cos(Ee / 2));
        var re = 1.00014 * (1 - 0.016709 * Math.cos(Ee));
        var oe = Le + nue - Me;
        var Ex = re * Math.cos(oe - Le + Le);
        var Ey = re * Math.sin(oe - Le + Le);
        // Use simpler Earth coords
        var lam_sun_r = (Sun.position(jd, lat, lon).ra - 180) * D2R;
        Ex = re * Math.cos(lam_sun_r + Math.PI);
        Ey = re * Math.sin(lam_sun_r + Math.PI);
        var Ez = 0;

        var eps = (23.439 - 0.0000004 * n) * D2R;
        var results = [];

        Object.keys(ELEMENTS).forEach(function (name) {
            var h = heliocentric(name, jd);
            if (!h) return;
            // Geocentric ecliptic
            var gx = h.x - Ex, gy = h.y - Ey, gz = h.z - Ez;
            var dist = Math.sqrt(gx * gx + gy * gy + gz * gz);
            // Rotate to equatorial
            var xeq = gx;
            var yeq = gy * Math.cos(eps) - gz * Math.sin(eps);
            var zeq = gy * Math.sin(eps) + gz * Math.cos(eps);
            var ra = Astro.mod(Math.atan2(yeq, xeq) * R2D, 360);
            var dec = Math.asin(Math.min(1, Math.max(-1, zeq / dist))) * R2D;
            var pos = Astro.raDecToAltAz(ra, dec, lat, lon, jd);
            // Rough magnitude (phase angle effect ignored)
            var baseMag = OPPOSITION_MAG[name];
            var phaseFactor = 5 * Math.log10(dist * h.r);
            var mag = baseMag + phaseFactor;
            results.push({
                name: name, ra: ra, dec: dec,
                alt: pos.alt, az: pos.az,
                mag: mag, dist: dist,
                color: PLANET_COLOR[name]
            });
        });
        return results;
    }

    return { positionAll: positionAll, PLANET_COLOR: PLANET_COLOR };
})();

// ─────────────────────────────────────────────
// 5. STAR CATALOG
// ─────────────────────────────────────────────
var StarCatalog = (function () {
    // Named bright stars: [name, RA_deg, Dec_deg, Magnitude, B-V color index]
    // B-V: < 0 = blue-white, ~0.3 = white, ~0.8 = yellow, ~1.2 = orange, > 1.4 = red
    var NAMED = [
        // ──── mag < 0 ────
        ['Sirius', 101.287, -16.716, -1.46, 0.01],
        ['Canopus', 95.988, -52.696, -0.74, 0.15],
        // ──── 0 – 1 ────
        ['Arcturus', 213.915, 19.182, -0.05, 1.23],
        ['Vega', 279.235, 38.784, 0.03, 0.00],
        ['Capella', 79.172, 45.998, 0.08, 0.80],
        ['Rigel', 78.634, -8.202, 0.12, -0.03],
        ['Procyon', 114.825, 5.225, 0.34, 0.43],
        ['Betelgeuse', 88.793, 7.407, 0.42, 1.50],
        ['Achernar', 24.429, -57.237, 0.46, -0.16],
        ['Hadar', 210.956, -60.373, 0.61, -0.23],
        ['Rigil Kent.', 219.902, -60.834, -0.01, 0.71],
        ['Altair', 297.696, 8.868, 0.77, 0.22],
        ['Acrux', 186.650, -63.099, 0.77, -0.24],
        ['Aldebaran', 68.980, 16.509, 0.85, 1.54],
        ['Spica', 201.298, -11.161, 0.97, -0.24],
        ['Antares', 247.352, -26.432, 1.06, 1.83],
        ['Pollux', 116.329, 28.026, 1.14, 1.00],
        ['Fomalhaut', 344.413, -29.622, 1.16, 0.09],
        ['Mimosa', 191.930, -59.689, 1.25, -0.24],
        ['Deneb', 310.358, 45.280, 1.25, 0.09],
        ['Regulus', 152.093, 11.967, 1.35, -0.11],
        // ──── 1 – 2 ────
        ['Adhara', 104.656, -28.972, 1.50, -0.21],
        ['Castor', 113.649, 31.889, 1.57, 0.03],
        ['Shaula', 263.402, -37.104, 1.62, -0.22],
        ['Gacrux', 187.792, -57.113, 1.63, 1.60],
        ['Bellatrix', 81.283, 6.350, 1.64, -0.22],
        ['Elnath', 81.573, 28.608, 1.65, -0.13],
        ['Miaplacidus', 138.300, -69.717, 1.67, 0.07],
        ['Alnilam', 84.053, -1.202, 1.70, -0.19],
        ['Alnitak', 85.190, -1.943, 1.74, -0.09],
        ['Alioth', 193.507, 55.960, 1.76, -0.02],
        ['Mirfak', 51.080, 49.861, 1.79, 0.48],
        ['Dubhe', 165.932, 61.751, 1.79, 1.07],
        ['Wezen', 107.098, -26.393, 1.84, 0.68],
        ['Kaus Aust.', 276.043, -34.385, 1.85, 1.51],
        ['Alkaid', 206.885, 49.313, 1.86, -0.19],
        ['Atria', 247.352, -69.028, 1.92, 1.44],
        ['Mirzam', 95.675, -17.957, 1.98, -0.24],
        ['Polaris', 37.955, 89.264, 1.99, 0.60],
        ['Peacock', 306.412, -56.735, 1.94, -0.19],
        ['Alhena', 99.428, 16.399, 1.93, 0.00],
        ['Menkalinan', 89.882, 44.947, 1.90, 0.03],
        ['Alphard', 141.897, -8.658, 1.99, 1.44],
        ['Hamal', 31.793, 23.463, 2.01, 1.15],
        ['Nunki', 283.816, -26.297, 2.05, -0.13],
        ['Alpheratz', 2.097, 29.090, 2.06, -0.11],
        ['Rasalhague', 263.734, 12.560, 2.07, 0.15],
        ['Mirach', 17.430, 35.620, 2.07, 1.58],
        ['Diphda', 10.897, -17.987, 2.04, 1.02],
        ['Saiph', 86.939, -9.670, 2.09, -0.16],
        ['Kochab', 222.676, 74.156, 2.08, 1.47],
        ['Mizar', 200.981, 54.925, 2.27, 0.16],
        ['Mintaka', 83.002, -0.299, 2.23, -0.22],
        ['Schedar', 10.127, 56.537, 2.24, 1.17],
        ['Alphecca', 233.672, 26.715, 2.22, 0.03],
        ['Eltanin', 269.152, 51.489, 2.24, 1.52],
        ['Algieba', 154.993, 19.842, 2.01, 1.14],
        ['Denebola', 177.265, 14.572, 2.14, 0.09],
        ['Algol', 47.042, 40.956, 2.12, 0.00],
        ['Dschubba', 240.083, -22.622, 2.32, -0.12],
        ['Sadr', 305.557, 40.257, 2.23, 0.67],
        ['Alderamin', 319.645, 62.585, 2.47, 0.22],
        ['Markab', 346.190, 15.205, 2.49, -0.04],
        ['Alcyone', 56.871, 24.105, 2.87, -0.09],
        ['Albireo', 292.680, 27.960, 3.08, 1.09],
        ['Phecda', 178.458, 53.695, 2.44, 0.04],
        ['Merak', 165.461, 56.383, 2.37, 0.03],
        ['Megrez', 183.857, 57.033, 3.31, 0.08],
        ['Ankaa', 6.571, -42.306, 2.40, 1.08],
        [null, 104.656, -28.972, 1.50, -0.21], // Adhara dup guard
        [null, 122.383, -47.337, 1.75, -0.26],
        [null, 95.675, -17.957, 1.98, -0.24],
        [null, 264.330, -43.000, 1.86, 0.40],
        [null, 125.628, -59.510, 1.86, 1.28],
        [null, 211.671, -36.369, 2.06, 1.01],
        [null, 218.877, -42.157, 2.31, -0.21],
        [null, 190.415, -1.449, 2.74, 0.36],
        [null, 168.527, 20.524, 2.56, 0.12],
        [null, 257.595, -15.723, 2.43, 0.06],
        [null, 252.541, -34.293, 2.29, 1.14],
        [null, 311.553, 33.970, 2.46, 1.03],
        [null, 286.353, 10.613, 2.72, 1.52],
        [null, 345.280, 28.083, 2.44, 1.67],
        [null, 229.252, -9.383, 2.61, -0.10],
        [null, 206.840, -47.288, 2.55, -0.20],
        [null, 247.555, 21.490, 2.77, 0.94],
        [null, 265.868, 4.567, 2.77, 1.17],
        [null, 14.177, 60.717, 2.47, -0.15],
        [null, 21.454, 60.235, 2.68, 0.13],
        [null, 275.249, -29.828, 2.70, 1.38],
        [null, 276.993, -25.421, 2.81, 1.04],
        [null, 285.653, -29.880, 2.60, 0.07],
        [null, 84.912, -34.074, 2.65, -0.12],
        [null, 83.183, -17.822, 2.58, 0.21],
        [null, 241.359, -19.806, 2.62, -0.08],
        [null, 190.379, -69.136, 2.69, -0.19],
        [null, 45.570, 4.090, 2.54, 1.64],
        [null, 76.962, -5.086, 2.79, 0.08],
        [null, 322.890, -5.571, 2.91, 0.83],
        [null, 326.760, -16.127, 2.85, 0.31],
        [null, 182.090, -50.722, 2.60, -0.12],
        [null, 139.273, -59.276, 2.25, 0.18],
        [null, 296.244, 45.131, 2.87, -0.04],
        [null, 248.971, -28.216, 2.82, -0.27],
        [null, 264.330, -37.295, 2.69, -0.22],
        [null, 249.290, -10.567, 2.54, 0.04],
        [null, 2.295, 59.150, 2.28, 0.34],
    ];

    // B-V color index → CSS color string
    function bvToColor(bv) {
        if (bv < -0.3) return '#9bb0ff';          // hot blue O/B
        if (bv < -0.1) return '#aabfff';          // blue-white B
        if (bv < 0.15) return '#cad7ff';          // white A
        if (bv < 0.40) return '#f8f7ff';          // yellow-white F
        if (bv < 0.75) return '#fff4ea';          // yellow G (sun-like)
        if (bv < 1.15) return '#ffd2a1';          // orange K
        return '#ffad51';                          // red M giant
    }

    // Procedural background stars – seeded PRNG, uniform on sphere
    function generateBackground(count) {
        var stars = [];
        var seed = 42;
        function rand() {
            seed = (seed * 1664525 + 1013904223) & 0xffffffff;
            return (seed >>> 0) / 0x100000000;
        }
        for (var i = 0; i < count; i++) {
            // Uniform on sphere
            var u = rand() * 2 - 1;
            var phi = rand() * 2 * Math.PI;
            var sinTheta = Math.sqrt(1 - u * u);
            var ra = Astro.mod(phi * Astro.R2D, 360);
            var dec = Math.asin(Math.max(-1, Math.min(1, u))) * Astro.R2D;
            var mag = 3.0 + rand() * 3.5;    // 3.0 – 6.5
            var bv = (rand() - 0.3) * 1.5;  // rough color spread
            stars.push({ ra: ra, dec: dec, mag: mag, bv: bv });
        }
        return stars;
    }

    var _bgStars = null;
    function getAll() {
        if (!_bgStars) _bgStars = generateBackground(5800);
        var result = NAMED.map(function (d) {
            return { name: d[0], ra: d[1], dec: d[2], mag: d[3], bv: d[4] };
        });
        return result.concat(_bgStars);
    }

    return { getAll: getAll, bvToColor: bvToColor };
})();

// ─────────────────────────────────────────────
// 6. SKY RENDERER
// ─────────────────────────────────────────────
var SkyRenderer = (function () {
    var canvas, ctx, W, H, CX, CY, R;
    var stars = null;

    function init(canvasEl) {
        canvas = canvasEl;
        ctx = canvas.getContext('2d');
        stars = StarCatalog.getAll();
        resize();
    }

    function resize() {
        W = canvas.width = window.innerWidth;
        H = canvas.height = window.innerHeight;
        CX = W / 2; CY = H / 2;
        R = Math.min(W, H) / 2 * 1.35;   // dome slightly overshoots edges
    }

    // alt/az → canvas x,y   (zenith = centre, horizon = edge)
    // az 0° = North (top), 90° = East (right), 180° = South (bottom)
    function project(alt, az) {
        var r = (90 - alt) / 90 * R;
        var azR = az * Astro.D2R;
        return {
            x: CX + Math.sin(azR) * r,
            y: CY - Math.cos(azR) * r
        };
    }

    // ── Sky gradient ──────────────────────────────────────────
    function lerp(a, b, t) { return a + (b - a) * t; }
    function lerpColor(c1, c2, t) {
        return [lerp(c1[0], c2[0], t) | 0,
        lerp(c1[1], c2[1], t) | 0,
        lerp(c1[2], c2[2], t) | 0];
    }
    function rgb(c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }
    function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }

    function skyColors(sunAlt) {
        var t;
        if (sunAlt <= -18) {
            return { z: [2, 2, 12], m: [4, 5, 18], h: [6, 8, 22] };
        } else if (sunAlt <= -12) {
            t = (sunAlt + 18) / 6;
            return {
                z: lerpColor([2, 2, 12], [5, 5, 25], t),
                m: lerpColor([4, 5, 18], [8, 8, 38], t),
                h: lerpColor([6, 8, 22], [14, 12, 52], t)
            };
        } else if (sunAlt <= -6) {
            t = (sunAlt + 12) / 6;
            return {
                z: lerpColor([5, 5, 25], [10, 10, 50], t),
                m: lerpColor([8, 8, 38], [18, 18, 80], t),
                h: lerpColor([14, 12, 52], [35, 30, 110], t)
            };
        } else if (sunAlt <= 0) {
            t = (sunAlt + 6) / 6;
            return {
                z: lerpColor([10, 10, 50], [22, 28, 90], t),
                m: lerpColor([18, 18, 80], [40, 55, 140], t),
                h: lerpColor([35, 30, 110], [90, 100, 190], t)
            };
        } else if (sunAlt <= 5) {
            t = sunAlt / 5;
            return {
                z: lerpColor([22, 28, 90], [42, 65, 130], t),
                m: lerpColor([40, 55, 140], [70, 105, 175], t),
                h: lerpColor([90, 100, 190], [190, 140, 80], t)  // golden glow
            };
        } else if (sunAlt <= 20) {
            t = (sunAlt - 5) / 15;
            return {
                z: lerpColor([42, 65, 130], [65, 110, 195], t),
                m: lerpColor([70, 105, 175], [95, 155, 215], t),
                h: lerpColor([190, 140, 80], [170, 210, 240], t)
            };
        } else {
            return { z: [65, 120, 205], m: [100, 165, 225], h: [175, 215, 240] };
        }
    }

    function drawSkyDome(sunAlt, sunAz, cloudCover) {
        // Radial gradient: zenith→horizon
        var c = skyColors(sunAlt);
        var grad = ctx.createRadialGradient(CX, CY, 0, CX, CY, R * 1.05);
        grad.addColorStop(0, rgb(c.z));
        grad.addColorStop(0.5, rgb(c.m));
        grad.addColorStop(1, rgb(c.h));
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);

        // Sun glow on horizon (golden/reddish band around sun az during twilight)
        if (sunAlt > -10 && sunAlt < 15) {
            var glowStr = Math.max(0, Math.min(1, (10 - Math.abs(sunAlt)) / 10));
            var sunPos = project(Math.max(0, sunAlt), sunAz);
            var hGrad = ctx.createRadialGradient(sunPos.x, CY, 0, sunPos.x, CY, R * 0.8);
            var glowColor = sunAlt > 0 ? 'rgba(255,160,60,' : 'rgba(255,100,40,';
            hGrad.addColorStop(0, glowColor + (glowStr * 0.45) + ')');
            hGrad.addColorStop(0.4, glowColor + (glowStr * 0.15) + ')');
            hGrad.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = hGrad;
            ctx.fillRect(0, 0, W, H);
        }
    }

    // ── Milky Way band ────────────────────────────────────────
    // Galactic north pole: RA=192.8595°, Dec=27.1284°
    function drawMilkyWay(jd, lat, lon, sunAlt, cloudCover) {
        var visibility = Math.max(0, Math.min(1, (-sunAlt - 5) / 15));
        visibility *= (1 - cloudCover * 0.012);
        if (visibility < 0.02) return;

        var GPN_RA = 192.8595, GPN_DEC = 27.1284;
        var steps = 120;
        for (var i = 0; i < steps; i++) {
            var glon = (i / steps) * 360;
            var glonR = glon * Astro.D2R;
            // Galactic to equatorial (simplified)
            var b = 0; // on galactic plane
            var bR = b * Astro.D2R;
            // Rotate galactic plane through RA/Dec
            var sinDec = Math.sin(bR) * Math.sin(GPN_DEC * Astro.D2R)
                + Math.cos(bR) * Math.cos(GPN_DEC * Astro.D2R) * Math.cos(glonR + (33 * Astro.D2R));
            sinDec = Math.max(-1, Math.min(1, sinDec));
            var decEq = Math.asin(sinDec) * Astro.R2D;
            var raEq = GPN_RA - Math.atan2(
                Math.cos(bR) * Math.sin(glonR + 33 * Astro.D2R),
                Math.sin(bR) * Math.cos(GPN_DEC * Astro.D2R)
                - Math.cos(bR) * Math.sin(GPN_DEC * Astro.D2R) * Math.cos(glonR + 33 * Astro.D2R)
            ) * Astro.R2D;
            raEq = Astro.mod(raEq, 360);

            var pos = Astro.raDecToAltAz(raEq, decEq, lat, lon, jd);
            if (pos.alt < -5) continue;
            var p = project(pos.alt, pos.az);
            // Brightness: peak near galactic centre (glon ≈ 0°)
            var density = 0.5 + 0.5 * Math.cos(glonR);
            var alpha = visibility * density * 0.18;
            var w = R * 0.08 * (0.5 + density * 0.5);
            var grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, w);
            grad.addColorStop(0, 'rgba(200,210,240,' + alpha + ')');
            grad.addColorStop(1, 'rgba(180,195,230,0)');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(p.x, p.y, w, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // ── Stars ─────────────────────────────────────────────────
    function drawStars(jd, lat, lon, sunAlt, cloudCover, time) {
        var baseVisibility = Math.max(0, Math.min(1, (-sunAlt - 5) / 15));
        if (baseVisibility < 0.01) return;
        var cloudFade = 1 - cloudCover * 0.009;

        for (var i = 0; i < stars.length; i++) {
            var s = stars[i];
            if (s.mag > 6.5) continue;
            var pos = Astro.raDecToAltAz(s.ra, s.dec, lat, lon, jd);
            if (pos.alt < -2) continue;

            var p = project(pos.alt, pos.az);
            if (p.x < -10 || p.x > W + 10 || p.y < -10 || p.y > H + 10) continue;

            // Atmospheric extinction – stronger near horizon
            var altR = Math.max(0.01, pos.alt) * Astro.D2R;
            var airmass = 1 / (Math.sin(altR) + 0.025 * Math.exp(-11 * Math.sin(altR)));
            var extinction = Math.min(0.95, airmass * 0.06);

            // Flux → size
            var flux = Math.pow(10, (0 - s.mag) / 2.5);
            var vis = Math.max(0, flux * baseVisibility * cloudFade * (1 - extinction * 0.7));

            var size = Math.min(3.8, 0.4 + 2.2 * Math.pow(10, (1.8 - Math.max(s.mag, -1.5)) / 4));

            // Chromatic scintillation: separate R/G/B flicker for low-altitude stars
            var scint = 0;
            if (pos.alt < 35 && s.mag > -0.5) {
                var sc = Math.max(0, (35 - pos.alt) / 35) * (0.18 + airmass * 0.04);
                scint = sc * Math.sin(time * 4.7 + s.ra * 0.13 + s.dec * 0.07);
            }
            var alpha = Math.min(0.98, vis * (1 + scint) * 1.5);
            if (alpha < 0.015) continue;

            var color = StarCatalog.bvToColor(s.bv);

            // Very bright stars: multi-layer glow + 4-point diffraction spike
            if (s.mag < 0.5) {
                // Wide soft corona
                var coronaR = size * 8;
                var cg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, coronaR);
                cg.addColorStop(0, hexAlpha(color, alpha * 0.3));
                cg.addColorStop(0.4, hexAlpha(color, alpha * 0.08));
                cg.addColorStop(1, hexAlpha(color, 0));
                ctx.fillStyle = cg;
                ctx.beginPath(); ctx.arc(p.x, p.y, coronaR, 0, Math.PI * 2); ctx.fill();
                // Diffraction spikes
                ctx.save();
                ctx.globalAlpha = alpha * 0.35;
                ctx.strokeStyle = color;
                ctx.lineWidth = 0.8;
                var spikeLen = size * 14;
                for (var sp = 0; sp < 4; sp++) {
                    var ang = sp * Math.PI / 2;
                    ctx.beginPath();
                    ctx.moveTo(p.x + Math.cos(ang) * size, p.y + Math.sin(ang) * size);
                    ctx.lineTo(p.x + Math.cos(ang) * spikeLen, p.y + Math.sin(ang) * spikeLen);
                    ctx.stroke();
                }
                ctx.restore();
            }

            // Mid glow for mag < 2.5
            if (s.mag < 2.5) {
                var glowR = size * (s.mag < 0 ? 5 : 3.5 - s.mag * 0.3);
                var gg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowR);
                gg.addColorStop(0, hexAlpha(color, alpha * 0.55));
                gg.addColorStop(1, hexAlpha(color, 0));
                ctx.fillStyle = gg;
                ctx.beginPath(); ctx.arc(p.x, p.y, glowR, 0, Math.PI * 2); ctx.fill();
            }

            // Star disc – slightly blurred point
            ctx.globalAlpha = alpha;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, size * 0.75, 0, Math.PI * 2);
            ctx.fill();

            // Hot core: white centre on bright stars
            if (s.mag < 1.8) {
                ctx.globalAlpha = alpha * 0.7;
                ctx.fillStyle = '#ffffff';
                ctx.beginPath();
                ctx.arc(p.x, p.y, size * 0.3, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = 1;
        }
    }

    // ── Sun disc ──────────────────────────────────────────────
    function drawSun(sunAlt, sunAz) {
        if (sunAlt < -2) return;
        var p = project(Math.max(0, sunAlt), sunAz);
        var alpha = Math.min(1, (sunAlt + 2) / 4);
        // Outer corona
        var grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 80);
        grad.addColorStop(0, 'rgba(255,230,100,' + alpha * 0.4 + ')');
        grad.addColorStop(0.3, 'rgba(255,200,60,' + alpha * 0.15 + ')');
        grad.addColorStop(1, 'rgba(255,160,20,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 80, 0, Math.PI * 2);
        ctx.fill();
        // Disc
        ctx.fillStyle = 'rgba(255,240,160,' + alpha + ')';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
        ctx.fill();
    }

    // ── Moon disc with phase ──────────────────────────────────
    function drawMoon(moonAlt, moonAz, phase, illuminated) {
        if (moonAlt < -1) return;
        var p = project(Math.max(0, moonAlt), moonAz);
        var moonR = 12;
        var alpha = Math.min(1, (moonAlt + 1) / 3) * 0.95;

        // Glow
        var gGrad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, moonR * 3.5);
        gGrad.addColorStop(0, 'rgba(220,225,240,' + alpha * 0.25 + ')');
        gGrad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gGrad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, moonR * 3.5, 0, Math.PI * 2);
        ctx.fill();

        // Dark body
        ctx.fillStyle = 'rgba(15,20,30,' + alpha + ')';
        ctx.beginPath();
        ctx.arc(p.x, p.y, moonR, 0, Math.PI * 2);
        ctx.fill();

        // Lit part (crescent / gibbous)
        ctx.save();
        ctx.beginPath();
        ctx.arc(p.x, p.y, moonR, 0, Math.PI * 2);
        ctx.clip();
        // Waxing (0–0.5): lit on right, waning (0.5–1): lit on left
        var litSide = phase < 0.5 ? 1 : -1;
        var tilt = (phase < 0.5 ? phase : 1 - phase) * 2; // 0→1→0
        var bulge = moonR * (2 * tilt - 1);
        ctx.fillStyle = 'rgba(240,240,210,' + alpha + ')';
        ctx.beginPath();
        // Left or right half always lit:
        ctx.arc(p.x, p.y, moonR, -Math.PI / 2, Math.PI / 2, phase >= 0.5);
        // Terminator ellipse
        ctx.ellipse(p.x, p.y, Math.abs(bulge), moonR,
            0, Math.PI / 2, -Math.PI / 2, phase >= 0.5);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    // ── Planets ───────────────────────────────────────────────
    function drawPlanets(planetData, sunAlt, time) {
        var nightVis = Math.max(0, Math.min(1, (-sunAlt) / 10));
        planetData.forEach(function (pl) {
            if (pl.alt < -1) return;
            if (pl.mag > 6.0) return;
            var p = project(Math.max(0, pl.alt), pl.az);
            var alpha = Math.min(0.97, nightVis + 0.15);
            if (sunAlt > 5) alpha *= Math.max(0, 1 - (sunAlt - 5) / 18);
            if (alpha < 0.05) return;

            // Disc radius scales with brightness
            var discR = Math.max(1.8, 3.5 + Math.max(0, (3 - pl.mag)) * 1.1);

            // ── Saturn: rings ──
            if (pl.name === 'Saturn') {
                ctx.save();
                ctx.globalAlpha = alpha * 0.65;
                // Ring: tilted ellipse, semi-axes ~2.4× disc
                var rx = discR * 2.5, ry = discR * 0.7;
                var ringGrad = ctx.createLinearGradient(p.x - rx, p.y, p.x + rx, p.y);
                ringGrad.addColorStop(0, 'rgba(200,185,140,0)');
                ringGrad.addColorStop(0.2, 'rgba(210,195,150,0.55)');
                ringGrad.addColorStop(0.45, 'rgba(230,210,165,0.7)');
                ringGrad.addColorStop(0.5, 'rgba(175,160,110,0.35)'); // Cassini gap
                ringGrad.addColorStop(0.55, 'rgba(230,210,165,0.7)');
                ringGrad.addColorStop(0.8, 'rgba(210,195,150,0.55)');
                ringGrad.addColorStop(1, 'rgba(200,185,140,0)');
                ctx.strokeStyle = ringGrad;
                ctx.lineWidth = ry * 1.5;
                ctx.beginPath();
                ctx.ellipse(p.x, p.y, rx, ry, 0, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
            }

            // Wide soft glow
            var glowR = discR * 4.5;
            var gGrad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowR);
            gGrad.addColorStop(0, hexAlpha(pl.color, alpha * 0.45));
            gGrad.addColorStop(0.5, hexAlpha(pl.color, alpha * 0.12));
            gGrad.addColorStop(1, hexAlpha(pl.color, 0));
            ctx.fillStyle = gGrad;
            ctx.beginPath(); ctx.arc(p.x, p.y, glowR, 0, Math.PI * 2); ctx.fill();

            // ── Jupiter: visible banding (two equatorial belts) ──
            if (pl.name === 'Jupiter' && discR > 3) {
                ctx.save();
                ctx.beginPath(); ctx.arc(p.x, p.y, discR, 0, Math.PI * 2); ctx.clip();
                // Base disc
                ctx.globalAlpha = alpha;
                ctx.fillStyle = pl.color;
                ctx.fillRect(p.x - discR, p.y - discR, discR * 2, discR * 2);
                // North equatorial belt
                ctx.globalAlpha = alpha * 0.45;
                ctx.fillStyle = 'rgba(160,110,70,1)';
                ctx.fillRect(p.x - discR, p.y - discR * 0.55, discR * 2, discR * 0.28);
                // South equatorial belt
                ctx.fillRect(p.x - discR, p.y + discR * 0.18, discR * 2, discR * 0.28);
                ctx.restore();
            } else {
                // Plain disc
                ctx.globalAlpha = alpha;
                ctx.fillStyle = pl.color;
                ctx.beginPath(); ctx.arc(p.x, p.y, discR, 0, Math.PI * 2); ctx.fill();
            }

            // Bright limb highlight
            ctx.globalAlpha = alpha * 0.4;
            var hilite = ctx.createRadialGradient(
                p.x - discR * 0.35, p.y - discR * 0.35, 0,
                p.x, p.y, discR);
            hilite.addColorStop(0, 'rgba(255,255,255,0.6)');
            hilite.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = hilite;
            ctx.beginPath(); ctx.arc(p.x, p.y, discR, 0, Math.PI * 2); ctx.fill();

            ctx.globalAlpha = 1;
        });
    }

    function hexToRgba(hex, alpha) {
        var r = parseInt(hex.slice(1, 3), 16),
            g = parseInt(hex.slice(3, 5), 16),
            b = parseInt(hex.slice(5, 7), 16);
        return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
    }

    // Helper: hex color + alpha string (works with both '#rrggbb' and 'rgb(…)')
    function hexAlpha(hex, a) {
        if (hex.charAt(0) === '#') {
            var r = parseInt(hex.slice(1, 3), 16),
                g = parseInt(hex.slice(3, 5), 16),
                b = parseInt(hex.slice(5, 7), 16);
            return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
        }
        // already rgb(...)
        return hex.replace('rgb(', 'rgba(').replace(')', ',' + a + ')');
    }

    // ── Labels ───────────────────────────────────────────────
    function drawLabel(text, x, y, color, alpha, size) {
        ctx.save();
        ctx.globalAlpha = Math.min(0.92, alpha);
        ctx.font = (size || 10) + 'px Inter,-apple-system,sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        // Dark halo for readability against any sky
        ctx.shadowColor = 'rgba(0,0,0,0.95)';
        ctx.shadowBlur = 5;
        ctx.fillStyle = color || 'rgba(255,255,255,0.85)';
        ctx.fillText(text, x, y);
        // Second pass — lighter inner fill, no shadow
        ctx.shadowBlur = 0;
        ctx.globalAlpha = Math.min(0.92, alpha) * 0.6;
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.fillText(text, x, y);
        ctx.restore();
    }

    function drawLabels(jd, lat, lon, sunAlt, planets, moon, sunPos) {
        var nightFade = Math.max(0, Math.min(1, (-sunAlt - 2) / 10));

        // ── Sun ──
        if (sunPos && sunPos.alt > -2) {
            var sp = project(Math.max(0, sunPos.alt), sunPos.az);
            var sa = Math.min(0.9, (sunPos.alt + 2) / 5);
            drawLabel('Sun', sp.x, sp.y - 20, 'rgba(255,235,120,0.9)', sa, 11);
        }

        // ── Moon ──
        if (moon && moon.alt > -1) {
            var mp = project(Math.max(0, moon.alt), moon.az);
            var ma = Math.min(0.9, (moon.alt + 1) / 4);
            drawLabel('Moon', mp.x, mp.y - 20, 'rgba(210,215,240,0.9)', ma, 11);
        }

        // ── Planets ──
        if (planets) {
            planets.forEach(function (pl) {
                if (pl.alt < 1 || pl.mag > 6.0) return;
                var pa = Math.max(0.25, Math.min(0.88, nightFade + 0.25));
                if (sunAlt > 5) pa *= Math.max(0, 1 - (sunAlt - 5) / 15);
                if (pa < 0.1) return;
                var pp = project(pl.alt, pl.az);
                var dotR = 2.5 + Math.max(0, (3 - pl.mag)) * 0.8;
                drawLabel(pl.name, pp.x, pp.y - dotR - 8, pl.color, pa, 11);
            });
        }

        // ── Named stars (bright, named only) ──
        if (nightFade < 0.15) return;  // don't draw star names during day
        var labelStars = stars.filter(function (s) { return s.name && s.mag <= 2.0; });
        labelStars.forEach(function (s) {
            var pos = Astro.raDecToAltAz(s.ra, s.dec, lat, lon, jd);
            if (pos.alt < 5) return;
            var p = project(pos.alt, pos.az);
            if (p.x < 5 || p.x > W - 5 || p.y < 5 || p.y > H - 5) return;
            var normBright = Math.pow(10, (0 - s.mag) / 2.5);
            var alpha = Math.min(0.75, normBright * nightFade * 1.2);
            if (alpha < 0.12) return;
            var starSize = 0.5 + 1.8 * Math.pow(10, (2 - Math.max(s.mag, -1.5)) / 4);
            drawLabel(s.name, p.x, p.y - starSize - 7,
                StarCatalog.bvToColor(s.bv), alpha * 0.9, 10);
        });
    }

    return {
        init: init, resize: resize, project: project,
        drawSkyDome: drawSkyDome, drawMilkyWay: drawMilkyWay,
        drawStars: drawStars, drawSun: drawSun,
        drawMoon: drawMoon, drawPlanets: drawPlanets,
        drawLabels: drawLabels
    };
})();

// ─────────────────────────────────────────────
// 7. WEATHER EFFECTS (clouds, rain, snow, fog)
// ─────────────────────────────────────────────
var WeatherFX = (function () {
    var canvas, ctx, W, H;
    var particles = [];
    var clouds = [];
    var cloudsSeed = 0;

    function init(canvasEl) {
        canvas = canvasEl;
        ctx = canvas.getContext('2d');
    }

    function resize(w, h) { W = w; H = h; }

    // ── Cloud layer ───────────────────────────────────────────
    // Each cloud is a formation of bubble centres. At draw time a smooth
    // quadratic-bezier hull is traced through the outermost points to produce
    // an organic, non-oval silhouette.

    function initClouds(cover, seed) {
        if (Math.abs(cover - cloudsSeed) < 5 && clouds.length > 0) return;
        cloudsSeed = cover;
        clouds = [];
        var rng = makeSeed(seed || 7);

        // Fewer formations, much slower drift
        var formationCount = Math.max(1, Math.floor(cover * 0.07));

        for (var f = 0; f < formationCount; f++) {
            var fcx = rng() * W * 1.3 - W * 0.15;
            var fcy = rng() * H * 0.38 + H * 0.04;
            var fScale = 0.7 + rng() * 1.2;
            var isHigh = rng() > 0.72;
            var isStorm = !isHigh && cover > 70 && rng() > 0.6;

            var bubbles = [];
            var bCount = isHigh ? (3 + Math.floor(rng() * 3))
                : (5 + Math.floor(rng() * 7));

            for (var b = 0; b < bCount; b++) {
                var bx2, by2, br2;
                if (isHigh) {
                    bx2 = fcx + (rng() - 0.5) * 420 * fScale;
                    by2 = fcy + (rng() - 0.5) * 22;
                    br2 = 28 + rng() * 55;
                } else {
                    var ang = rng() * Math.PI * 2;
                    var dist = rng() * 120 * fScale;
                    bx2 = fcx + Math.cos(ang) * dist;
                    by2 = fcy + Math.sin(ang) * dist * 0.42 - rng() * 40 * fScale;
                    br2 = 38 + rng() * 70 * fScale;
                    if (isStorm) br2 *= 1.5;
                }
                bubbles.push({ x: bx2, y: by2, r: br2 });
            }

            clouds.push({
                cx: fcx, cy: fcy,
                bubbles: bubbles,
                isHigh: isHigh,
                isStorm: isStorm,
                alpha: isHigh ? 0.10 + rng() * 0.12
                    : isStorm ? 0.55 + rng() * 0.20
                        : 0.28 + rng() * 0.30,
                speed: isHigh ? 0.008 + rng() * 0.006
                    : 0.003 + rng() * 0.007,
            });
        }
    }

    function updateClouds(dt) {
        clouds.forEach(function (cloud) {
            var dx = cloud.speed * dt;
            cloud.cx += dx;
            cloud.bubbles.forEach(function (b) { b.x += dx; });
            // Wrap: when rightmost edge leaves screen, jump to left
            var maxX = -Infinity;
            cloud.bubbles.forEach(function (b) { if (b.x + b.r > maxX) maxX = b.x + b.r; });
            if (maxX < -60) {
                var shift = W + 120;
                cloud.cx += shift;
                cloud.bubbles.forEach(function (b) { b.x += shift; });
            }
        });
    }

    // Trace a smooth closed curve through the outermost envelope of a bubble set.
    function buildCloudPath(bubbles) {
        if (!bubbles.length) return;
        // Sample many points around each bubble perimeter
        var pts = [];
        var N = 12;
        bubbles.forEach(function (b) {
            for (var k = 0; k < N; k++) {
                var a = (k / N) * Math.PI * 2;
                pts.push({
                    x: b.x + Math.cos(a) * b.r,
                    y: b.y + Math.sin(a) * b.r
                });
            }
        });
        // Find centroid
        var cx2 = 0, cy2 = 0;
        pts.forEach(function (p) { cx2 += p.x; cy2 += p.y; });
        cx2 /= pts.length; cy2 /= pts.length;
        // Keep outermost point per angular sector
        var sectors = 32;
        var outer = [];
        for (var s = 0; s < sectors; s++) {
            var a0 = (s / sectors) * Math.PI * 2;
            var a1 = ((s + 1) / sectors) * Math.PI * 2;
            var best = null, bestD = -1;
            pts.forEach(function (p) {
                var a = Math.atan2(p.y - cy2, p.x - cx2);
                if (a < 0) a += Math.PI * 2;
                if (a >= a0 && a < a1) {
                    var d = (p.x - cx2) * (p.x - cx2) + (p.y - cy2) * (p.y - cy2);
                    if (d > bestD) { bestD = d; best = p; }
                }
            });
            if (best) outer.push(best);
        }
        if (outer.length < 3) return;
        // Smooth closed curve through midpoints (Chaikin-style)
        var n = outer.length;
        ctx.moveTo((outer[0].x + outer[n - 1].x) / 2,
            (outer[0].y + outer[n - 1].y) / 2);
        for (var i = 0; i < n; i++) {
            var cur = outer[i];
            var nxt = outer[(i + 1) % n];
            ctx.quadraticCurveTo(cur.x, cur.y,
                (cur.x + nxt.x) / 2, (cur.y + nxt.y) / 2);
        }
        ctx.closePath();
    }

    function drawClouds(cover, sunAlt) {
        if (cover < 4) return;

        var dayT = Math.max(0, Math.min(1, (sunAlt + 2) / 12));
        var goldenT = (sunAlt > -4 && sunAlt < 9)
            ? Math.max(0, 1 - Math.abs(sunAlt - 3) / 6) : 0;
        var lBase = Math.floor(dayT * 215 + 18);
        var cr = Math.min(255, Math.max(18, lBase + Math.floor(goldenT * 38)));
        var cg = Math.min(255, Math.max(20, lBase + Math.floor(goldenT * 14)));
        var cb = Math.min(255, Math.max(26, lBase - Math.floor(goldenT * 12)
            + Math.floor((1 - dayT) * 18)));
        var coverFrac = cover / 100;

        clouds.forEach(function (cloud) {
            var a = cloud.alpha * coverFrac;
            if (a < 0.015) return;
            var bubbles = cloud.bubbles;

            // Compute bounding box for gradient
            var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            bubbles.forEach(function (b) {
                if (b.x - b.r < minX) minX = b.x - b.r;
                if (b.x + b.r > maxX) maxX = b.x + b.r;
                if (b.y - b.r < minY) minY = b.y - b.r;
                if (b.y + b.r > maxY) maxY = b.y + b.r;
            });

            ctx.save();

            if (cloud.isHigh) {
                // Cirrus: individual soft horizontal wisps, no outline
                bubbles.forEach(function (b) {
                    var wg = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
                    wg.addColorStop(0, 'rgba(' + cr + ',' + cg + ',' + cb + ',' + (a * 0.6) + ')');
                    wg.addColorStop(0.5, 'rgba(' + cr + ',' + cg + ',' + cb + ',' + (a * 0.25) + ')');
                    wg.addColorStop(1, 'rgba(' + cr + ',' + cg + ',' + cb + ',0)');
                    ctx.fillStyle = wg;
                    ctx.beginPath();
                    ctx.ellipse(b.x, b.y, b.r, b.r * 0.26, 0, 0, Math.PI * 2);
                    ctx.fill();
                });
            } else {
                // Cumulus/storm: organic hull filled with vertical gradient
                var dr = cloud.isStorm ? Math.max(10, cr - 65) : Math.max(18, cr - 25);
                var dg2 = cloud.isStorm ? Math.max(12, cg - 65) : Math.max(20, cg - 25);
                var db = cloud.isStorm ? Math.max(18, cb - 50) : Math.max(22, cb - 16);

                var linGrad = ctx.createLinearGradient(0, minY, 0, maxY);
                linGrad.addColorStop(0, 'rgba(' + cr + ',' + cg + ',' + cb + ',' + (a) + ')');
                linGrad.addColorStop(0.42, 'rgba(' + cr + ',' + cg + ',' + cb + ',' + (a * 0.88) + ')');
                linGrad.addColorStop(0.75, 'rgba(' + dr + ',' + dg2 + ',' + db + ',' + (a * 0.62) + ')');
                linGrad.addColorStop(1, 'rgba(' + dr + ',' + dg2 + ',' + db + ',' + (a * 0.28) + ')');

                // Fill organic shape
                ctx.beginPath();
                buildCloudPath(bubbles);
                ctx.fillStyle = linGrad;
                ctx.fill();

                // Soft outer glow for depth
                ctx.beginPath();
                buildCloudPath(bubbles);
                ctx.shadowColor = 'rgba(' + cr + ',' + cg + ',' + cb + ',0.20)';
                ctx.shadowBlur = 22;
                ctx.strokeStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',' + (a * 0.10) + ')';
                ctx.lineWidth = 4;
                ctx.stroke();
                ctx.shadowBlur = 0;
            }
            ctx.restore();
        });
    }

    // ── Rain particles ────────────────────────────────────────
    function initRain(intensity) {
        var count = Math.floor(intensity * 4);
        particles = particles.filter(function (p) { return p.type === 'snow'; });
        var rng = makeSeed(13);
        for (var i = 0; i < count; i++) {
            particles.push({
                type: 'rain',
                x: rng() * W,
                y: rng() * H,
                len: 10 + rng() * 15,
                speed: 8 + rng() * 6,
                drift: (rng() - 0.5) * 1.5,
                alpha: 0.3 + rng() * 0.35
            });
        }
    }

    function initSnow(intensity) {
        var count = Math.floor(intensity * 2.5);
        particles = particles.filter(function (p) { return p.type === 'rain'; });
        var rng = makeSeed(17);
        for (var i = 0; i < count; i++) {
            particles.push({
                type: 'snow',
                x: rng() * W,
                y: rng() * H,
                r: 1.5 + rng() * 3,
                speed: 0.8 + rng() * 1.5,
                drift: (rng() - 0.5) * 0.8,
                phase: rng() * Math.PI * 2,
                alpha: 0.4 + rng() * 0.4
            });
        }
    }

    function updateParticles(dt) {
        particles.forEach(function (p) {
            if (p.type === 'rain') {
                p.y += p.speed * dt * 0.06;
                p.x += p.drift * dt * 0.02;
                if (p.y > H + p.len) { p.y = -p.len; p.x = Math.random() * W; }
            } else {
                p.y += p.speed * dt * 0.015;
                p.x += p.drift * dt * 0.01 + Math.sin(p.phase + p.y * 0.01) * 0.3;
                p.phase += 0.005 * dt;
                if (p.y > H + 10) { p.y = -10; p.x = Math.random() * W; }
            }
        });
    }

    function drawParticles() {
        particles.forEach(function (p) {
            ctx.globalAlpha = p.alpha;
            if (p.type === 'rain') {
                ctx.strokeStyle = 'rgba(180,200,230,0.7)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(p.x, p.y);
                ctx.lineTo(p.x + p.drift * p.len * 0.15, p.y + p.len);
                ctx.stroke();
            } else {
                ctx.fillStyle = 'rgba(240,245,255,0.8)';
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
                ctx.fill();
            }
        });
        ctx.globalAlpha = 1;
    }

    // ── Fog / mist ────────────────────────────────────────────
    function drawFog(intensity, H_param) {
        if (intensity < 0.05) return;
        var grad = ctx.createLinearGradient(0, H_param * 0.5, 0, H_param);
        grad.addColorStop(0, 'rgba(200,210,220,0)');
        grad.addColorStop(0.6, 'rgba(200,210,220,' + intensity * 0.25 + ')');
        grad.addColorStop(1, 'rgba(210,215,225,' + intensity * 0.55 + ')');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H_param);
    }

    // ── Seeded PRNG ───────────────────────────────────────────
    function makeSeed(s) {
        var seed = s;
        return function () {
            seed = (seed * 1664525 + 1013904223) & 0xffffffff;
            return (seed >>> 0) / 0x100000000;
        };
    }

    return {
        init: init, resize: resize,
        initClouds: initClouds, updateClouds: updateClouds, drawClouds: drawClouds,
        initRain: initRain, initSnow: initSnow,
        updateParticles: updateParticles, drawParticles: drawParticles,
        drawFog: drawFog
    };
})();

// ─────────────────────────────────────────────
// 8. WEATHER FETCH – Open-Meteo
// ─────────────────────────────────────────────
var SkyWeather = (function () {
    var CACHE_KEY = 'sky-weather-cache';
    var CACHE_TTL = 12 * 60 * 1000;  // 12 min
    var appPaused = false;

    var state = {
        cloudCover: 0,
        weatherCode: 0,
        temperature: null,
        humidity: null,
        windSpeed: null,
        windDir: null,
        visibility: null,
        precipitation: 0,
        precipProb: 0,
        sunrise: null,
        sunset: null,
        timezone: null,
        unitSystem: 'imperial',
        location: { name: '', lat: 30.2676, lon: -97.743 },
        forecast: []
    };

    function getUnitSystem() {
        var s = localStorage.getItem('unit-system');
        return s === 'metric' ? 'metric' : 'imperial';
    }

    async function fetch(loc) {
        if (appPaused || window.isPrimaryView === false) return;
        var unit = getUnitSystem();
        var tempUnit = unit === 'metric' ? 'celsius' : 'fahrenheit';
        var windUnit = unit === 'metric' ? 'kmh' : 'mph';
        var url = 'https://api.open-meteo.com/v1/forecast' +
            '?latitude=' + loc.lat + '&longitude=' + loc.lon +
            '&current=temperature_2m,relative_humidity_2m,weather_code,' +
            'wind_speed_10m,wind_direction_10m,cloud_cover,precipitation,' +
            'visibility,is_day' +
            '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset' +
            '&hourly=precipitation_probability' +
            '&temperature_unit=' + tempUnit +
            '&wind_speed_unit=' + windUnit +
            '&timezone=auto&forecast_days=1';
        try {
            var res = await window.fetch(url);
            var data = await res.json();
            var cur = data.current;
            state.cloudCover = cur.cloud_cover || 0;
            state.weatherCode = cur.weather_code || 0;
            state.temperature = cur.temperature_2m;
            state.humidity = cur.relative_humidity_2m;
            state.windSpeed = cur.wind_speed_10m;
            state.windDir = cur.wind_direction_10m;
            state.visibility = cur.visibility;
            state.precipitation = cur.precipitation || 0;
            state.precipProb = data.hourly && data.hourly.precipitation_probability
                ? (data.hourly.precipitation_probability[0] || 0) : 0;
            state.sunrise = data.daily && data.daily.sunrise ? data.daily.sunrise[0] : null;
            state.sunset = data.daily && data.daily.sunset ? data.daily.sunset[0] : null;
            state.timezone = data.timezone || null;
            state.unitSystem = unit;
            state.location = loc;
            state.forecast = data.daily ? data.daily.time.map(function (d, i) {
                return {
                    day: formatDay(d),
                    high: data.daily.temperature_2m_max[i],
                    low: data.daily.temperature_2m_min[i],
                    code: data.daily.weather_code[i]
                };
            }) : [];
            localStorage.setItem(CACHE_KEY, JSON.stringify({ data: state, ts: Date.now() }));
            updateUI();
        } catch (e) {
            // Load from cache on failure
            loadCache();
        }
    }

    function loadCache() {
        try {
            var raw = localStorage.getItem(CACHE_KEY);
            if (!raw) return;
            var obj = JSON.parse(raw);
            if (Date.now() - obj.ts < CACHE_TTL * 4) {
                Object.assign(state, obj.data);
                updateUI();
            }
        } catch (e) { }
    }

    function formatDay(dateStr) {
        var d = new Date(dateStr + 'T12:00:00');
        var today = new Date(); today.setHours(12, 0, 0, 0);
        var diff = Math.round((d - today) / 86400000);
        if (diff === 0) return 'Today';
        if (diff === 1) return 'Tmrw';
        return d.toLocaleDateString('en-US', { weekday: 'short' });
    }

    function schedule(loc) {
        fetch(loc);
        setInterval(function () { fetch(loc); }, CACHE_TTL);
    }

    function setPaused(p) { appPaused = p; }
    function getState() { return state; }

    return {
        schedule: schedule, fetch: fetch, loadCache: loadCache,
        getState: getState, setPaused: setPaused
    };
})();

// ─────────────────────────────────────────────
// 9. UI OVERLAY
// ─────────────────────────────────────────────
function updateUI() {
    var s = SkyWeather.getState();

    // City
    var cityEl = document.getElementById('sky-city');
    if (cityEl && s.location.name) cityEl.textContent = s.location.name;

    // Temperature & condition
    var tempEl = document.getElementById('sky-temperature');
    var condEl = document.getElementById('sky-condition');
    if (tempEl && s.temperature != null) {
        var unit = s.unitSystem === 'metric' ? '°C' : '°F';
        tempEl.innerHTML = Math.round(s.temperature) + '<span class="unit">' + unit + '</span>';
    }
    if (condEl) condEl.textContent = wmoToSkyCondition(s.weatherCode);

    // Subtitle: clock
    updateSkySubtitle(s.timezone);

    // Stats
    var statsEl = document.getElementById('sky-stats');
    if (statsEl) {
        var wu = s.unitSystem === 'metric' ? 'km/h' : 'mph';
        var items = [];
        if (s.humidity != null) items.push({ l: 'Humidity', v: Math.round(s.humidity) + '%' });
        if (s.windSpeed != null) items.push({ l: 'Wind', v: Math.round(s.windSpeed) + ' ' + wu });
        if (s.cloudCover != null) items.push({ l: 'Cloud', v: Math.round(s.cloudCover) + '%' });
        statsEl.innerHTML = items.map(function (x) {
            return '<div class="stat-item"><span class="stat-label">' + x.l + '</span>'
                + '<span class="stat-value">' + x.v + '</span></div>';
        }).join('');
    }
}

function updateSkySubtitle(tz) {
    var el = document.getElementById('sky-subtitle');
    if (!el) return;
    var tz_ = tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
    var now = new Date();
    var day = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: tz_ });
    var date = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz_ });
    var time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz_ });
    el.textContent = day + ', ' + date + ' · ' + time;
}

function updateSkyObjects(planets, moon) {
    var el = document.getElementById('sky-objects');
    if (!el) return;
    var html = '';
    // Moon
    if (moon && moon.alt > 0) {
        var phaseName = moonPhaseName(moon.phase);
        html += '<div class="sky-object-item">'
            + '<div class="sky-object-dot" style="background:#d8dce8;box-shadow:0 0 6px #d8dce8;"></div>'
            + '<span class="sky-object-name">Moon</span>'
            + '<span class="sky-object-alt"> · ' + phaseName
            + ' · ' + Math.round(moon.alt) + '°</span>'
            + '</div>';
    }
    // Visible planets
    planets.forEach(function (pl) {
        if (pl.alt < 3) return;
        if (pl.mag > 5.5) return;
        html += '<div class="sky-object-item">'
            + '<div class="sky-object-dot" style="background:' + pl.color + ';"></div>'
            + '<span class="sky-object-name">' + pl.name + '</span>'
            + '<span class="sky-object-alt"> · ' + Math.round(pl.alt) + '°</span>'
            + '</div>';
    });
    el.innerHTML = html || '<span class="bar-loading" style="color:var(--text-dim)">No planets above horizon</span>';
}

function moonPhaseName(phase) {
    if (phase < 0.03 || phase > 0.97) return 'New';
    if (phase < 0.22) return 'Waxing Crescent';
    if (phase < 0.28) return 'First Quarter';
    if (phase < 0.47) return 'Waxing Gibbous';
    if (phase < 0.53) return 'Full';
    if (phase < 0.72) return 'Waning Gibbous';
    if (phase < 0.78) return 'Last Quarter';
    return 'Waning Crescent';
}

function wmoToSkyCondition(code) {
    if (code == null || code === 0) return 'Clear Skies';
    if (code === 1) return 'Mostly Clear';
    if (code === 2) return 'Partly Cloudy';
    if (code === 3) return 'Overcast';
    if (code === 45 || code === 48) return 'Foggy';
    if (code >= 51 && code <= 55) return 'Drizzle';
    if (code >= 56 && code <= 57) return 'Freezing Drizzle';
    if (code >= 61 && code <= 65) return 'Rain';
    if (code >= 66 && code <= 67) return 'Freezing Rain';
    if (code >= 71 && code <= 77) return 'Snow';
    if (code >= 80 && code <= 82) return 'Showers';
    if (code >= 85 && code <= 86) return 'Snow Showers';
    if (code === 95) return 'Thunderstorms';
    if (code >= 96) return 'Hail & Thunder';
    return 'Fair Skies';
}

// ─────────────────────────────────────────────
// 10. MAIN LOOP
// ─────────────────────────────────────────────
(function () {
    var canvas = document.getElementById('sky-canvas');
    var ctx = canvas.getContext('2d');
    var paused = false;
    var lastTime = 0;
    var prevWeatherCode = -1;

    // Default location (Austin TX) until native host injects real one
    var DEFAULT_LOC = { name: 'Austin, TX', lat: 30.2676, lon: -97.743 };

    function getLocation() {
        if (window.userLocation && window.userLocation.lat) return window.userLocation;
        var rawLat = localStorage.getItem('last-location-lat');
        var rawLon = localStorage.getItem('last-location-lon');
        if (rawLat && rawLon) {
            var la = parseFloat(rawLat), lo = parseFloat(rawLon);
            if (!isNaN(la) && !isNaN(lo)) {
                return { name: window.userLocation && window.userLocation.name ? window.userLocation.name : '', lat: la, lon: lo };
            }
        }
        return DEFAULT_LOC;
    }

    SkyRenderer.init(canvas);
    WeatherFX.init(canvas);

    function onResize() {
        SkyRenderer.resize();
        WeatherFX.resize(window.innerWidth, window.innerHeight);
    }
    window.addEventListener('resize', onResize);
    onResize();

    // Start weather fetch
    var loc = getLocation();
    SkyWeather.schedule(loc);

    // Re-schedule when location injected from Swift
    var prevLoc = null;
    function checkLocationChange() {
        var cur = getLocation();
        if (!prevLoc || cur.lat !== prevLoc.lat || cur.lon !== prevLoc.lon) {
            prevLoc = cur;
            SkyWeather.fetch(cur);
            var cityEl = document.getElementById('sky-city');
            if (cityEl && cur.name) cityEl.textContent = cur.name;
        }
    }
    setInterval(checkLocationChange, 4000);

    // Clock refresh every minute
    setInterval(function () {
        updateSkySubtitle(SkyWeather.getState().timezone);
    }, 60000);

    // RAF loop
    function loop(timestamp) {
        if (paused) return;
        var dt = Math.min(timestamp - lastTime, 50);
        lastTime = timestamp;

        var loc_ = getLocation();
        var now = new Date();
        var jd = Astro.julianDate(now);
        var time = timestamp * 0.001;   // seconds

        var sun = Sun.position(jd, loc_.lat, loc_.lon);
        var moon = Moon.position(jd, loc_.lat, loc_.lon);
        var pls = Planets.positionAll(jd, loc_.lat, loc_.lon);
        var wx = SkyWeather.getState();

        // Determine weather effect intensities
        var code = wx.weatherCode;
        var cloud = wx.cloudCover;

        // If weather code changed, re-init particles
        if (code !== prevWeatherCode) {
            prevWeatherCode = code;
            var isRain = (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code === 95 || code >= 96;
            var isSnow = (code >= 71 && code <= 77) || (code >= 85 && code <= 86);
            if (isRain) WeatherFX.initRain(wx.precipitation > 0 ? wx.precipitation * 60 + 30 : 40);
            else if (isSnow) WeatherFX.initSnow(wx.precipitation > 0 ? wx.precipitation * 50 + 20 : 30);
            else { /* clear particles */ }
            WeatherFX.initClouds(cloud, Math.floor(loc_.lat * 100));
        }

        WeatherFX.updateClouds(dt);
        WeatherFX.updateParticles(dt);

        // ── Draw ──────────────────────────────────────────────
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        SkyRenderer.drawSkyDome(sun.alt, sun.az, cloud);
        SkyRenderer.drawMilkyWay(jd, loc_.lat, loc_.lon, sun.alt, cloud);
        SkyRenderer.drawStars(jd, loc_.lat, loc_.lon, sun.alt, cloud, time);
        SkyRenderer.drawSun(sun.alt, sun.az);
        SkyRenderer.drawMoon(moon.alt, moon.az, moon.phase, moon.illuminated);
        SkyRenderer.drawPlanets(pls, sun.alt, time);
        SkyRenderer.drawLabels(jd, loc_.lat, loc_.lon, sun.alt, pls, moon, sun);

        // Weather overlays (drawn on same canvas but above sky)
        WeatherFX.drawClouds(cloud, sun.alt);
        WeatherFX.drawParticles();

        // Fog: visible < 1000 m or WMO code 45/48
        var isFog = (code === 45 || code === 48) || (wx.visibility != null && wx.visibility < 1000);
        if (isFog) WeatherFX.drawFog(0.55, canvas.height);
        else if (wx.visibility != null && wx.visibility < 5000) WeatherFX.drawFog(0.15, canvas.height);

        // Update UI objects panel periodically (not every frame)
        if (Math.floor(time) % 30 < 0.1) {
            updateSkyObjects(pls, moon);
        }

        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);

    // Initial objects update
    setTimeout(function () {
        var loc_ = getLocation();
        var jd = Astro.julianDate(new Date());
        var pls = Planets.positionAll(jd, loc_.lat, loc_.lon);
        var moon = Moon.position(jd, loc_.lat, loc_.lon);
        updateSkyObjects(pls, moon);
    }, 2000);

    // Expose pause/resume for Swift host
    window.setAppPaused = function (p) {
        paused = p;
        SkyWeather.setPaused(p);
        if (!p) requestAnimationFrame(loop);
    };

    // Allow Swift to inject location same as globe view
    window.userLocation = window.userLocation || null;
})();
