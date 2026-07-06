"""
H1Z1 pack1 adaptation layer for ryanjsims/pydmod (which targets PS2 / pack2).

This module is imported by `export_z1_instanced.py`; importing it applies all
the monkeypatches needed to read H1Z1's pack1 archives and load its actor
meshes. It can also be run directly to export a small GLB of one town for
visual sanity-checking (`python export_z1_collision.py`).

Adaptations:
  1. Stub `cnk_loader` so zone_converter imports without the C++ terrain module
     (safe as long as terrain `-t` is NOT enabled -> stub never instantiated).
  2. Fall back to the ModelRigid input layout when pydmod's (PS2-derived)
     material DB lacks an H1Z1 material (we only need POSITIONS for collision).
  3. Route AssetManager.get_raw through the pack1 ChainMap (pack1 stores
     plaintext names; the original get_raw is pack2/crc64-only).
  4. Point the asset manager at the H1Z1 pack1 archives, loaded synchronously.
  5. Skip (don't crash on) actors whose material still can't be resolved.

Env vars:
  H1Z1_ASSETS  directory holding Assets_*.pack  (default: D:/h1z1/Resources/Assets)
  COLLISION_OUT  output path for the town GLB when run directly (default: ./z1_actors_town.glb)
"""
import os
import sys
import types
import builtins
from glob import glob
from pathlib import Path

# Auto-answer the dme_loader material-layout prompt. For static structures the
# [12,24] stride ambiguity lists: 1=POS_TEX2_SKINWEIGHTS 2=ClrNrmUV 3=ModelRigid
# 4=Vehicle. Pick 3 (ModelRigid): POSITION in stream0, NO skin attributes
# (option 1 wrongly emits skin_indices -> KeyError on the empty bone_map).
builtins.input = lambda *a, **k: "3"

# --- 1. Stub cnk_loader (terrain) before importing zone_converter ---
_stub = types.ModuleType("cnk_loader")
class _CnkStub:  # never instantiated unless terrain is enabled
    pass
_stub.ForgelightChunk = _CnkStub
_stub.CNK0 = _CnkStub
_stub.CNK1 = _CnkStub
sys.modules["cnk_loader"] = _stub

from DbgPack import AssetManager  # noqa: E402
import zone_converter  # noqa: E402
import dme_loader.dme_loader as _dl  # noqa: E402

# --- 2. Resilient material/layout resolution. pydmod's (PS2-derived) material
# DB lacks ~18 H1Z1 props' materials AND its own fallback 'VehicleRigid'
# (hash 570440238) -> Material.input_layout() raises KeyError, dropping the
# actor. For collision we only need POSITIONS (stream0), so on any failure fall
# back to the ModelRigid layout (POSITION in stream0, no skin attrs). Mesh.load
# still re-validates strides and may re-guess from there.
_orig_input_layout = _dl.Material.input_layout

def _safe_input_layout(self, material_hash=None):
    try:
        return _orig_input_layout(self, material_hash)
    except Exception:
        try:
            return _dl.InputLayouts["ModelRigid"]
        except Exception:
            return None

_dl.Material.input_layout = _safe_input_layout

# --- 3. pack1-compatible get_raw (case-insensitive plaintext lookup) ---
def _pack1_get_raw(self, name):
    idx = getattr(self, "_ci_index", None)
    if idx is None:
        idx = {k.lower(): v for k, v in self.assets.items()}
        self._ci_index = idx
    return idx.get(name.lower())

AssetManager.get_raw = _pack1_get_raw

# --- 4. load H1Z1 pack1 archives synchronously ---
ASSETS_DIR = os.environ.get("H1Z1_ASSETS", "D:/h1z1/Resources/Assets")
_H1Z1 = sorted(glob(os.path.join(ASSETS_DIR, "Assets_*.pack")))

def _patched_get_manager(pool, live=False):
    if zone_converter.manager is not None:
        return zone_converter.manager
    if not _H1Z1:
        raise FileNotFoundError(
            f"No Assets_*.pack found in {ASSETS_DIR!r}. "
            f"Set H1Z1_ASSETS to your H1Z1 Resources/Assets directory."
        )
    print(f"[export] loading {len(_H1Z1)} pack1 archives (sync)...")
    zone_converter.manager = AssetManager([Path(p) for p in _H1Z1])
    print(f"[export] loaded, assets: {len(zone_converter.manager.assets)}")
    return zone_converter.manager

zone_converter.get_manager = _patched_get_manager

# --- 5. resilient actor loading: skip actors whose material/layout is not in
# pydmod's (PS2-derived) material DB instead of crashing the whole export.
_stats = {"ok": 0, "skip": 0, "skipped_names": []}
_orig_dme_from_adr = zone_converter.dme_from_adr

def _safe_dme_from_adr(manager, actor_file):
    try:
        dme = _orig_dme_from_adr(manager, actor_file)
        if dme is not None:
            _stats["ok"] += 1
        return dme
    except Exception as e:
        _stats["skip"] += 1
        if len(_stats["skipped_names"]) < 40:
            _stats["skipped_names"].append(f"{actor_file}: {type(e).__name__} {e}")
        return None

zone_converter.dme_from_adr = _safe_dme_from_adr

if __name__ == "__main__":
    # Optional: export a small GLB of one town to eyeball in a glTF viewer.
    # "Z1.zone" is pulled straight from the packs (zone_converter falls back to
    # the asset manager when the path is not a real file).
    out = Path(os.environ.get("COLLISION_OUT", "z1_actors_town.glb"))
    sys.argv = [
        "zone_converter.py",
        "Z1.zone",
        str(out),
        "-f", "glb",
        "-a",            # actors (structures) only
        "-s",            # skip saving textures (collision = geometry only)
        "-b", "-1950", "-3850", "-1750", "-3650",
    ]
    zone_converter.main()
    print(f"\n=== ACTOR COVERAGE ===")
    print(f"actor types exported OK: {_stats['ok']}   skipped: {_stats['skip']}")
    for s in _stats["skipped_names"][:15]:
        print(f"  - {s}")
    print(f"wrote {out} ({out.stat().st_size / 1e6:.2f} MB)")
