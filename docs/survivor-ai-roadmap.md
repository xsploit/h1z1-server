# Survivor NPC implementation contract

Human survivors reuse the server's existing NPC, Recast, collision, inventory,
equipment, loot, weapon, damage, animation, and replication systems. New code
may coordinate those systems, but must not maintain a second fake inventory,
damage model, or movement simulation.

## Completed foundation

- Native Z1 terrain is extracted from the client's CNK0 triangle topology.
- NPC feet select from structure collision, terrain, and Recast in that order.
- Unknown world props are non-walkable; only explicit ground/building surfaces
  participate in grounding.
- Existing zombie FSM movement/perception is reused for melee survivors.
- `/groundinfo` reports terrain sampling, structure, navmesh, and the selected
  surface at the player's location.

## Next: coherent generated kits

A survivor receives one weighted archetype, then constrained variation inside
that archetype:

- military: matching field clothing, military pack/armor, service weapon;
- security/police: uniform pieces, light armor, handgun or shotgun;
- medic: matching scrubs/medical clothing, pack, bandages/medical supplies;
- scavenger: civilian layers, improvised storage, mixed melee/ranged gear;
- civilian: ordinary clothing, sparse supplies, usually no armor.

The generated items are equipped through `generateItem` and `equipItem` and
remain the survivor's authoritative inventory. Death loot comes from that same
inventory. Weapon choice always includes compatible ammunition; clothing slots
are chosen as a compatible set rather than independently random noise.

Until ranged combat is implemented, generated kits must use the working unified
melee weapon and may vary only appearance, storage, armor, and carried supplies.

## Then: goal-driven looting

Looting is an out-of-combat goal, not a replacement for combat behavior.

1. Periodically inspect nearby existing loot entities/containers.
2. Score items from actual needs: usable weapon, compatible ammunition,
   medicine, armor, storage, food/water, then crafting value.
3. Reserve one target so multiple survivors do not dog-pile the same item.
4. Use the existing nav agent to reach it; abandon unreachable/stale targets.
5. Transfer through the existing container/inventory/equipment APIs.
6. Cancel looting when a hostile is perceived or damage is received.

Scans are staggered and spatially bounded. A survivor owns at most one loot goal,
and no full-world scan runs in an AI tick.

## Then: ranged combat

Ranged survivors use the existing weapon definitions, projectile/hit pipeline,
damage handling, sounds, equipment replication, and client firing animations.
The server controls decisions and validates hits.

Accuracy is modeled, not scripted:

- reaction delay before the first shot;
- aim error based on distance, movement, stance, visibility, and suppression;
- weapon-specific burst length, cadence, reload, and effective range;
- line-of-sight plus friendly-fire checks;
- target memory that decays after losing sight.

Acceptance requires visible turning/aiming, a real fire animation and sound,
weapon/ammunition consumption, non-zero misses at ordinary range, cover-aware
navigation, and no proximity or timer-only damage.

## Later: survivor interaction

Friendly survivors, faction reputation, dialogue, AI-generated decisions, and
speech layer on top of the deterministic game-state systems above. An external
AI may choose a high-level intent or line of dialogue; it must not directly
author movement, damage, inventory mutations, or frame-by-frame combat.
