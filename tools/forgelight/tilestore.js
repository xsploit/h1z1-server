// Single source of truth for the streaming navmesh tile store: the canonical
// generation config + the GLOBAL fixed tile grid. Both the offline workers and
// the server import this so worker-generated tiles and the server's runtime
// navmesh share identical config and (tx,tz) coordinates.

// canonical generation config (locked here so it can't drift via env)
process.env.NAV_TILESIZE = "128";
process.env.NAV_CS = "0.2";
process.env.NAV_CH = "0.2";
process.env.NAV_SLOPE = "70";
process.env.NAV_CLIMB = "1.5";
process.env.NAV_TSTEP = "1";

const { NAV_CONFIG, buildRegionGeometry } = require("./gen_navmesh");

// world origin of tile (0,0) and a generous Y range covering the whole map
const ORIGIN = [-4096, -100, -4096];
const Y_MAX = 600;
// tile size in world meters = tileSize(cells) * cs
const TCS = NAV_CONFIG.tileSize * NAV_CONFIG.cs;
// runtime loaded-navmesh budget (Detour: tileBits+polyBits<=21, salt>=10):
// up to 2048 tiles loaded at once (~1150m window) x 1024 polys/tile
const RUNTIME_MAX_TILES = 2048;
const RUNTIME_MAX_POLYS = 1024;

function tileX(worldX) {
  return Math.floor((worldX - ORIGIN[0]) / TCS);
}
function tileZ(worldZ) {
  return Math.floor((worldZ - ORIGIN[2]) / TCS);
}
function tileBounds(tx, tz) {
  return {
    bmin: [ORIGIN[0] + tx * TCS, ORIGIN[1], ORIGIN[2] + tz * TCS],
    bmax: [ORIGIN[0] + (tx + 1) * TCS, Y_MAX, ORIGIN[2] + (tz + 1) * TCS]
  };
}

module.exports = {
  NAV_CONFIG,
  buildRegionGeometry,
  ORIGIN,
  Y_MAX,
  TCS,
  RUNTIME_MAX_TILES,
  RUNTIME_MAX_POLYS,
  tileX,
  tileZ,
  tileBounds
};
